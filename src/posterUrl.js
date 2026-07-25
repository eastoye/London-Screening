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
