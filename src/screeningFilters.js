import {
  ACCESSIBILITY_OPTIONS,
  FORMAT_OPTIONS,
  PROGRAMME_OPTIONS,
  getScreeningFormatValues,
} from "./screeningPresentation.js";

export { ACCESSIBILITY_OPTIONS, FORMAT_OPTIONS, PROGRAMME_OPTIONS };

export const GENRE_OPTIONS = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "History",
  "Horror",
  "Music",
  "Mystery",
  "Romance",
  "Science Fiction",
  "Thriller",
  "War",
  "Western",
];

export const UK_CERTIFICATION_OPTIONS = ["U", "PG", "12", "12A", "15", "18", "R18"];

export const DEFAULT_SCREENING_FILTERS = Object.freeze({
  watchlistOnly: false,
  genres: Object.freeze([]),
  certifications: Object.freeze([]),
  formats: Object.freeze([]),
  accessibility: Object.freeze([]),
  programmeTypes: Object.freeze([]),
  hideSoldOut: false,
});

export function normaliseScreeningFilters(value = {}) {
  return {
    watchlistOnly: Boolean(value.watchlistOnly),
    genres: Array.isArray(value.genres) ? [...new Set(value.genres)] : [],
    certifications: Array.isArray(value.certifications)
      ? [...new Set(value.certifications)]
      : [],
    formats: Array.isArray(value.formats) ? [...new Set(value.formats)] : [],
    accessibility: Array.isArray(value.accessibility)
      ? [...new Set(value.accessibility)]
      : [],
    programmeTypes: Array.isArray(value.programmeTypes)
      ? [...new Set(value.programmeTypes)]
      : [],
    hideSoldOut: Boolean(value.hideSoldOut),
  };
}

export function countScreeningFilters(value) {
  const filters = normaliseScreeningFilters(value);

  return (
    Number(filters.watchlistOnly) +
    filters.genres.length +
    filters.certifications.length +
    filters.formats.length +
    filters.accessibility.length +
    filters.programmeTypes.length +
    Number(filters.hideSoldOut)
  );
}

export function screeningMatchesMetadataFilters(screening, value) {
  const filters = normaliseScreeningFilters(value);

  if (
    filters.hideSoldOut &&
    (screening.availability_status === "sold_out" || screening.sold_out === true)
  ) {
    return false;
  }

  if (filters.genres.length > 0) {
    const genres = Array.isArray(screening.movies?.genres)
      ? screening.movies.genres
      : [];

    if (!filters.genres.some((genre) => genres.includes(genre))) {
      return false;
    }
  }

  if (filters.certifications.length > 0) {
    const hasConfirmedCertification =
      screening.movies?.uk_certification_status === "confirmed" &&
      filters.certifications.includes(screening.movies?.uk_certification);

    if (!hasConfirmedCertification) {
      return false;
    }
  }

  if (filters.formats.length > 0) {
    const formats = getScreeningFormatValues(screening);

    if (!filters.formats.some((format) => formats.includes(format))) {
      return false;
    }
  }

  if (filters.accessibility.length > 0) {
    const accessibility = Array.isArray(screening.accessibility_features)
      ? screening.accessibility_features
      : [];

    if (!filters.accessibility.some((feature) => accessibility.includes(feature))) {
      return false;
    }
  }

  if (filters.programmeTypes.length > 0) {
    const programmeTypes = Array.isArray(screening.programme_types)
      ? screening.programme_types
      : [];

    if (!filters.programmeTypes.some((type) => programmeTypes.includes(type))) {
      return false;
    }
  }

  return true;
}
