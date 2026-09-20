const YOUTUBE_KEY = /^[A-Za-z0-9_-]{11}$/;

export function getMovieTrailerUrl(movie) {
  if (movie?.match_status !== "matched") return null;
  const currentId = Number(movie.tmdb_id);
  const checkedId = Number(movie.trailer_tmdb_id);
  if (!Number.isSafeInteger(currentId) || currentId <= 0 ||
      !Number.isSafeInteger(checkedId) || currentId !== checkedId) return null;
  if (typeof movie.trailer_youtube_key !== "string" ||
      !YOUTUBE_KEY.test(movie.trailer_youtube_key)) return null;
  if (typeof movie.trailer_checked_at !== "string" ||
      !Number.isFinite(Date.parse(movie.trailer_checked_at))) return null;
  return `https://www.youtube.com/watch?v=${movie.trailer_youtube_key}`;
}
