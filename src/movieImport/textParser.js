import { IMPORT_SOURCE, createImportRecord, validYear } from "./model.js";

function extractRating(value) {
  const match = value.match(/(?:,|\s+-\s+)\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(5|10))\s*$/i);

  if (!match) return { value, rating: null, ratingScale: null };

  return {
    value: value.slice(0, match.index).trim(),
    rating: Number(match[1]),
    ratingScale: Number(match[2]),
  };
}

function extractYear(value) {
  const bracketed = value.match(/\s*[([]((?:18|19|20)\d{2})[)\]]\s*$/);
  const separated = value.match(/(?:,|\s+-\s+|\s+)((?:18|19|20)\d{2})\s*$/);
  const match = bracketed || separated;

  if (!match || !validYear(match[1])) return { value, year: null };

  return {
    value: value.slice(0, match.index).replace(/[,\s-]+$/, "").trim(),
    year: Number(match[1]),
  };
}

export function parseTextLine(raw, rowNumber) {
  const compact = String(raw || "").trim();
  const ratingResult = extractRating(compact);
  const yearResult = extractYear(ratingResult.value);

  return createImportRecord({
    title: yearResult.value,
    year: yearResult.year,
    rating: ratingResult.rating,
    ratingScale: ratingResult.ratingScale,
    watchlist: ratingResult.rating === null,
    source: IMPORT_SOURCE.TEXT,
    sourceRef: `Line ${rowNumber}`,
    raw,
  });
}

export function parseTextInput(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line, index) => ({ line, rowNumber: index + 1 }))
    .filter(({ line }) => line.trim())
    .map(({ line, rowNumber }) => parseTextLine(line, rowNumber));
}
