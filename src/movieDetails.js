function cleanText(value) {
  return String(value ?? "").trim();
}

function normaliseDirectorList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanText).filter(Boolean);
}

function stableKey(value) {
  if (Array.isArray(value)) {
    return [...value]
      .map((item) => cleanText(item).toLowerCase())
      .filter(Boolean)
      .sort()
      .join("|");
  }
  return cleanText(value).toLowerCase();
}

function representativeValue(values) {
  const counts = new Map();

  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const key = stableKey(value);
    if (!key) continue;

    const entry = counts.get(key) ?? { value, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }

  if (counts.size === 0) return null;

  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  if (ranked.length > 1 && ranked[0].count === ranked[1].count) return null;

  return ranked[0].value;
}

function cinemaVotes(screenings, field, transform = (value) => value) {
  const byCinema = new Map();

  for (const screening of screenings) {
    const cinema = cleanText(screening.cinema_name) || `screening:${screening.id}`;
    const raw = transform(screening[field]);
    if (raw === null || raw === undefined || raw === "") continue;

    const values = byCinema.get(cinema) ?? [];
    values.push(raw);
    byCinema.set(cinema, values);
  }

  const votes = [];
  for (const values of byCinema.values()) {
    const vote = representativeValue(values);
    if (vote !== null) votes.push(vote);
  }
  return votes;
}

function dominantExact(votes) {
  if (votes.length === 0) return null;
  if (votes.length === 1) return votes[0];

  const counts = new Map();
  for (const value of votes) {
    const key = stableKey(value);
    const entry = counts.get(key) ?? { value, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }

  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const best = ranked[0];
  const second = ranked[1];

  if (second && best.count === second.count) return null;
  if (best.count <= votes.length / 2) return null;

  return best.value;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function dominantRuntime(votes) {
  const numericVotes = votes
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0 && value < 600);

  if (numericVotes.length === 0) return null;
  if (numericVotes.length === 1) return Math.round(numericVotes[0]);

  let bestCluster = [];

  for (const candidate of numericVotes) {
    const cluster = numericVotes.filter(
      (value) => Math.abs(value - candidate) <= 2
    );

    if (cluster.length > bestCluster.length) {
      bestCluster = cluster;
    } else if (
      cluster.length === bestCluster.length &&
      cluster.length > 0 &&
      Math.abs(median(cluster) - candidate) <
        Math.abs(median(bestCluster) - candidate)
    ) {
      bestCluster = cluster;
    }
  }

  if (bestCluster.length <= numericVotes.length / 2) return null;
  return Math.round(median(bestCluster));
}

export function resolveMovieDetails(movie, screenings = []) {
  const safeMovieMatch = movie?.match_status === "matched";

  const sourceYears = cinemaVotes(
    screenings,
    "source_release_year",
    (value) => {
      const numeric = Number(value);
      return Number.isInteger(numeric) && numeric >= 1870 && numeric <= 2100
        ? numeric
        : null;
    }
  );

  const sourceRuntimes = cinemaVotes(
    screenings,
    "source_runtime_minutes",
    (value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
    }
  );

  const sourceDirectors = cinemaVotes(
    screenings,
    "source_directors",
    normaliseDirectorList
  );

  const movieYear = Number(movie?.release_year);
  const releaseYear =
    safeMovieMatch &&
    Number.isInteger(movieYear) &&
    movieYear >= 1870 &&
    movieYear <= 2100
      ? movieYear
      : dominantExact(sourceYears);

  const runtimeMinutes = dominantRuntime(sourceRuntimes);
  const directors = dominantExact(sourceDirectors) ?? [];

  const genres =
    safeMovieMatch && Array.isArray(movie?.genres)
      ? movie.genres.map(cleanText).filter(Boolean)
      : [];

  const ukCertification =
    safeMovieMatch &&
    movie?.uk_certification_status === "confirmed" &&
    cleanText(movie?.uk_certification)
      ? cleanText(movie.uk_certification)
      : null;

  return {
    releaseYear,
    runtimeMinutes,
    directors,
    genres,
    ukCertification,
  };
}

export function addSharedMovieDetails(screenings) {
  const rowsByMovie = new Map();

  for (const screening of screenings) {
    const movieId = cleanText(screening.movie_id);
    if (!movieId) continue;

    const rows = rowsByMovie.get(movieId) ?? [];
    rows.push(screening);
    rowsByMovie.set(movieId, rows);
  }

  const detailsByMovie = new Map();

  for (const [movieId, rows] of rowsByMovie) {
    const movie = rows.find((row) => row.movies)?.movies ?? null;
    detailsByMovie.set(movieId, resolveMovieDetails(movie, rows));
  }

  return screenings.map((screening) => {
    const movieId = cleanText(screening.movie_id);
    return {
      ...screening,
      shared_movie_details: movieId
        ? detailsByMovie.get(movieId) ?? null
        : null,
    };
  });
}

export function formatRuntime(minutes) {
  const numeric = Number(minutes);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const rounded = Math.round(numeric);
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;

  if (hours === 0) return `${remainder} min`;
  if (remainder === 0) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}
