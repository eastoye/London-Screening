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

export const FORMAT_OPTIONS = [
  { value: "35mm", label: "35mm" },
  { value: "70mm", label: "70mm" },
  { value: "imax", label: "IMAX" },
];

export const DEFAULT_SCREENING_FILTERS = Object.freeze({
  watchlistOnly: false,
  genres: Object.freeze([]),
  certifications: Object.freeze([]),
  formats: Object.freeze([]),
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
    const formats = Array.isArray(screening.projection_formats)
      ? screening.projection_formats
      : [];

    if (!filters.formats.some((format) => formats.includes(format))) {
      return false;
    }
  }

  return true;
}
