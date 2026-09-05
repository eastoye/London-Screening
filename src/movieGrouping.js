function cleanedMovieTitle(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function movieGroupingKey(screening) {
  const movieId = String(screening.movie_id ?? "").trim();
  if (movieId) return `movie:${movieId}`;

  const tmdbId = Number(screening.movies?.tmdb_id);
  if (Number.isInteger(tmdbId) && tmdbId > 0) return `tmdb:${tmdbId}`;

  const title = cleanedMovieTitle(screening.movie_title);
  return title ? `title:${title}` : `screening:${screening.id}`;
}

export function groupScreeningsByMovie(screenings) {
  const grouped = new Map();

  for (const screening of screenings) {
    const key = movieGroupingKey(screening);

    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        title: screening.movie_title,
        movie: screening.movies,
        screenings: [],
      });
    }

    grouped.get(key).screenings.push(screening);
  }

  return Array.from(grouped.values())
    .map((group) => {
      const rows = [...group.screenings].sort(
        (first, second) =>
          new Date(first.start_time).getTime() -
          new Date(second.start_time).getTime()
      );

      return {
        ...group,
        movie: rows.find((row) => row.movies)?.movies ?? group.movie,
        screenings: rows,
        cinemaCount: new Set(
          rows.map((row) => row.cinema_name).filter(Boolean)
        ).size,
      };
    })
    .sort(
      (first, second) =>
        new Date(first.screenings[0].start_time).getTime() -
        new Date(second.screenings[0].start_time).getTime()
    );
}
