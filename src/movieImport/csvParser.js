import {
  IMPORT_SOURCE,
  createImportRecord,
  normaliseImdbId,
  positiveInteger,
} from "./model.js";

function detectDelimiter(firstLine) {
  const candidates = [",", "\t", ";"];
  return candidates.sort(
    (first, second) =>
      firstLine.split(second).length - firstLine.split(first).length
  )[0];
}

export function parseCsvRows(value) {
  const text = String(value || "").replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] || "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field);
  if (row.some((item) => item.trim())) rows.push(row);
  return rows;
}

function headerKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function firstValue(data, aliases) {
  for (const alias of aliases) {
    const value = data.get(alias);
    if (value !== undefined && String(value).trim() !== "") return value;
  }
  return "";
}

function sourceFromHeaders(headers, filename) {
  const keys = new Set(headers.map(headerKey));
  const name = String(filename || "").toLowerCase();

  if (keys.has("letterboxd uri") || name.includes("letterboxd")) {
    return IMPORT_SOURCE.LETTERBOXD;
  }
  if (keys.has("const") || keys.has("your rating") || name.includes("imdb")) {
    return IMPORT_SOURCE.IMDB;
  }
  return IMPORT_SOURCE.CSV;
}

export function parseCsvInput(value, options = {}) {
  const rows = parseCsvRows(value);
  if (rows.length < 2) return [];

  const headers = rows[0].map(headerKey);
  const source = options.source || sourceFromHeaders(headers, options.filename);
  const isLetterboxd = source === IMPORT_SOURCE.LETTERBOXD;

  return rows.slice(1).map((values, index) => {
    const data = new Map(headers.map((header, column) => [header, values[column] || ""]));
    const ratingValue = firstValue(data, [
      "your rating",
      "rating",
      "personal rating",
      "user rating",
    ]);
    const imdbValue = firstValue(data, ["const", "imdb id", "imdb", "url"]);

    return createImportRecord({
      title: firstValue(data, ["title", "name", "movie title", "original title"]),
      year: firstValue(data, ["year", "release year"]),
      rating: ratingValue,
      ratingScale: isLetterboxd ? 5 : 10,
      watchlist: !ratingValue,
      imdbId: normaliseImdbId(imdbValue),
      tmdbId: positiveInteger(firstValue(data, ["tmdb id", "tmdb"])),
      traktId: positiveInteger(firstValue(data, ["trakt id", "trakt"])),
      source,
      sourceRef: `${options.filename || "CSV"} row ${index + 2}`,
      raw: values.join(","),
    });
  });
}
