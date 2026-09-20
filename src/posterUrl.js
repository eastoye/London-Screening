// TMDB image configuration. The poster_path stored in the `movies` table is
// combined with a size prefix to build a full URL. Only the small poster size
// is needed for compact list rows.
// See: https://developer.themoviedb.org/docs/image-basics

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";

// w185 is a good portrait size for ~80px-wide thumbnails (2:3 aspect).
const POSTER_SIZE = "w185";

export function posterUrl(posterPath) {
  if (!posterPath) return null;
  if (!posterPath.startsWith("/")) posterPath = `/${posterPath}`;
  return `${TMDB_IMAGE_BASE}${POSTER_SIZE}${posterPath}`;
}

function externalArtworkUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

// Poster priority is deliberately conservative:
// 1. a safely matched TMDB poster
// 2. verified artwork supplied by the cinema importer for this screening
// 3. no URL, allowing the UI to render its placeholder
export function posterCandidates(movie, verifiedArtworkUrl) {
  const candidates = [];

  if (movie?.match_status === "matched") {
    const tmdbUrl = posterUrl(movie.poster_path);
    if (tmdbUrl) candidates.push(tmdbUrl);
  }

  const sourceUrl = externalArtworkUrl(verifiedArtworkUrl);
  if (sourceUrl && !candidates.includes(sourceUrl)) {
    candidates.push(sourceUrl);
  }

  return candidates;
}
