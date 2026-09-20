// TMDB video candidates belong to the already matched movie ID.
const YOUTUBE_KEY = /^[A-Za-z0-9_-]{11}$/;
const UNRELIABLE_NAME = /\b(fan[ -]?made|fan edit|concept|reaction|review|analysis|parody)\b/i;

export function validYoutubeKey(value) {
  return typeof value === "string" && YOUTUBE_KEY.test(value);
}

function candidate(video) {
  if (!video || typeof video !== "object") return null;
  if (video.site !== "YouTube" || video.type !== "Trailer") return null;
  if (!validYoutubeKey(video.key)) return null;
  if (video.official !== true && video.official !== false) return null;

  const name = typeof video.name === "string" ? video.name.trim() : "";
  if (UNRELIABLE_NAME.test(name)) return null;
  if (video.official === false && !/\btrailer\b/i.test(name)) return null;

  const language = typeof video.iso_639_1 === "string"
    ? video.iso_639_1.toLowerCase() : "";
  const region = typeof video.iso_3166_1 === "string"
    ? video.iso_3166_1.toUpperCase() : "";
  const published = typeof video.published_at === "string"
    ? Date.parse(video.published_at) : NaN;
  return {
    key: video.key,
    official: video.official,
    language,
    region,
    size: Number.isInteger(video.size) ? video.size : 0,
    published: Number.isFinite(published) ? published : 0,
  };
}

function compare(a, b) {
  if (a.official !== b.official) return a.official ? -1 : 1;
  if ((a.language === "en") !== (b.language === "en")) {
    return a.language === "en" ? -1 : 1;
  }
  const regionRank = (region) => region === "GB" ? 0 : region === "US" ? 1 : 2;
  if (regionRank(a.region) !== regionRank(b.region)) {
    return regionRank(a.region) - regionRank(b.region);
  }
  if (a.size !== b.size) return b.size - a.size;
  if (a.published !== b.published) return b.published - a.published;
  return a.key.localeCompare(b.key, "en");
}

// A null result is cached as "checked but no suitable trailer".
export function selectMovieTrailer(videos) {
  if (!Array.isArray(videos)) return null;
  const byKey = new Map();
  for (const video of videos) {
    const item = candidate(video);
    if (!item) continue;
    const previous = byKey.get(item.key);
    if (!previous || compare(item, previous) < 0) byKey.set(item.key, item);
  }
  const selected = [...byKey.values()].sort(compare)[0];
  return selected?.key ?? null;
}
