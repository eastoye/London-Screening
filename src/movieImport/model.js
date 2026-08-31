const CURRENT_YEAR = new Date().getUTCFullYear();

export const IMPORT_SOURCE = Object.freeze({
  TEXT: "text",
  CSV: "csv",
  IMDB: "imdb",
  LETTERBOXD: "letterboxd",
});

export function comparableTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function validYear(value) {
  const year = Number(value);

  return Number.isInteger(year) && year >= 1870 && year <= CURRENT_YEAR + 3
    ? year
    : null;
}

export function normaliseImdbId(value) {
  const match = String(value || "").match(/tt\d{5,12}/i);
  return match ? match[0].toLowerCase() : null;
}

export function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function normaliseRating(value, scale = 10) {
  const numericValue = Number(value);
  const numericScale = Number(scale);

  if (
    !Number.isFinite(numericValue) ||
    !Number.isFinite(numericScale) ||
    numericScale <= 0 ||
    numericValue <= 0 ||
    numericValue > numericScale
  ) {
    return null;
  }

  return Math.max(1, Math.min(10, Math.round((numericValue / numericScale) * 10)));
}

export function createImportRecord(input) {
  const title = String(input.title || "").trim().replace(/\s+/g, " ");
  const year = validYear(input.year);
  const tmdbId = positiveInteger(input.tmdbId);
  const traktId = positiveInteger(input.traktId);
  const imdbId = normaliseImdbId(input.imdbId);
  const ratingScale = Number(input.ratingScale) || 10;
  const rating =
    input.rating === null || input.rating === undefined || input.rating === ""
      ? null
      : normaliseRating(input.rating, ratingScale);
  const originalRating = rating === null ? null : Number(input.rating);

  return {
    clientId: String(input.clientId || crypto.randomUUID()),
    title,
    year,
    rating,
    originalRating,
    ratingScale: rating === null ? null : ratingScale,
    watchlist: input.watchlist !== false && rating === null
      ? true
      : Boolean(input.watchlist),
    imdbId,
    tmdbId,
    traktId,
    source: input.source || IMPORT_SOURCE.TEXT,
    sourceRefs: [String(input.sourceRef || "").trim()].filter(Boolean),
    raw: String(input.raw || ""),
    invalidReason:
      !title && !tmdbId && !traktId && !imdbId
        ? "A title or stable movie ID is required."
        : input.rating !== null &&
            input.rating !== undefined &&
            input.rating !== "" &&
            rating === null
          ? "The rating is outside its stated scale."
          : null,
  };
}

function preMatchKey(record) {
  if (record.tmdbId) return `tmdb:${record.tmdbId}`;
  if (record.imdbId) return `imdb:${record.imdbId}`;
  if (record.traktId) return `trakt:${record.traktId}`;

  const title = comparableTitle(record.title);
  return title ? `title:${title}:${record.year || ""}` : `row:${record.clientId}`;
}

function mergeRecord(target, incoming) {
  const ratingRecord = incoming.rating !== null ? incoming : target;
  const ratingConflict = Boolean(
    target.rating !== null &&
      incoming.rating !== null &&
      target.rating !== incoming.rating
  );

  return {
    ...target,
    title: target.title || incoming.title,
    year: target.year || incoming.year,
    imdbId: target.imdbId || incoming.imdbId,
    tmdbId: target.tmdbId || incoming.tmdbId,
    traktId: target.traktId || incoming.traktId,
    rating: ratingRecord.rating,
    originalRating: ratingRecord.originalRating,
    ratingScale: ratingRecord.ratingScale,
    watchlist: target.watchlist || incoming.watchlist,
    sourceRefs: Array.from(new Set([...target.sourceRefs, ...incoming.sourceRefs])),
    duplicateCount: (target.duplicateCount || 1) + (incoming.duplicateCount || 1),
    ratingConflict: target.ratingConflict || incoming.ratingConflict || ratingConflict,
    invalidReason:
      target.invalidReason ||
      incoming.invalidReason ||
      (ratingConflict ? "Duplicate rows contain different ratings." : null),
  };
}

export function deduplicateBeforeMatching(records) {
  const byKey = new Map();

  for (const record of records) {
    const key = preMatchKey(record);
    byKey.set(key, byKey.has(key) ? mergeRecord(byKey.get(key), record) : record);
  }

  return Array.from(byKey.values());
}

export function deduplicateConfirmed(records) {
  const byTmdbId = new Map();

  for (const record of records) {
    const tmdbId = positiveInteger(record.selectedTmdbId || record.match?.tmdbId);
    if (!tmdbId) continue;

    const confirmed = { ...record, selectedTmdbId: tmdbId };
    byTmdbId.set(
      tmdbId,
      byTmdbId.has(tmdbId) ? mergeRecord(byTmdbId.get(tmdbId), confirmed) : confirmed
    );
  }

  return Array.from(byTmdbId.values());
}
