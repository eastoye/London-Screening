export interface ElectricFilm {
  vistaId?: string;
  title: string;
  image?: string | false;
  link?: string;
  rating?: string;
  premiere?: string;
  director?: string;
  screeningTypes?: string[];
}

export interface ElectricScreening {
  id: number;
  film: string;
  d: string;
  t: string;
  cinema: string;
  st?: string;
  sn?: string;
  r?: string;
  bookable: boolean;
  link: string | false;
  message?: string;
}

export interface ElectricScreeningType {
  title?: string;
  popupTitle?: string;
  popupText?: string;
  booking_confirm_checkbox?: string;
}

export interface SourceMetadata {
  filmTitleHint: string | null;
  releaseYear: number | null;
  directors: string[];
  eventUrl: string | null;
  artworkUrl: string | null;
  bookingUrl: string | null;
  screenName: string | null;
  projectionFormats: Array<"35mm" | "70mm" | "imax">;
  accessibilityFeatures: Array<"captioned" | "audio_described" | "relaxed">;
  programmeTypes: Array<"members_only" | "parent_and_baby" | "child_required" | "seniors">;
  availabilityStatus: "available" | "sold_out" | "unknown";
  screeningLabel: string | null;
  screeningTags: Array<
    | "q_and_a" | "introduction" | "discussion" | "premiere" | "preview"
    | "anniversary" | "double_bill" | "live_music" | "singalong" | "no_adverts"
    | "family_friendly" | "send_friendly" | "subtitled" | "dubbed"
    | "rerelease" | "restoration"
  >;
  soldOut: boolean;
}

const BASE_URL = "https://www.electriccinema.co.uk";

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function sameSiteUrl(value: string | false | undefined, pathPrefix: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, BASE_URL);
    if (url.protocol !== "https:" || url.hostname !== "www.electriccinema.co.uk") return null;
    if (!url.pathname.startsWith(pathPrefix)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseReleaseYear(value: string | undefined): number | null {
  const match = value?.match(/^((?:18|19|20|21)\d{2})-\d{2}-\d{2}$/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1888 && year <= 2200 ? year : null;
}

function cleanTitleHint(title: string, screeningType: string): string | null {
  let value = title.trim();
  if (screeningType === "BABY") {
    value = value.replace(/^Parent\s+(?:&|and)\s+Baby\s*:\s*/i, "");
  }
  value = value.replace(/\s*\(\d+(?:st|nd|rd|th)\s+Anniversary\)\s*$/i, "").trim();
  return value || null;
}

function splitDirectors(value: string | undefined): string[] {
  if (!value) return [];
  return unique(value.split(/\s*(?:•|;|\||\/)\s*/));
}

function projectionFormats(label: string): Array<"35mm" | "70mm" | "imax"> {
  const result: Array<"35mm" | "70mm" | "imax"> = [];
  if (/\b35\s*mm\b/i.test(label)) result.push("35mm");
  if (/\b70\s*mm\b/i.test(label)) result.push("70mm");
  if (/\bIMAX\b/i.test(label)) result.push("imax");
  return result;
}

export function buildSourceMetadata(
  film: ElectricFilm,
  screening: ElectricScreening,
  typeInfo: ElectricScreeningType | undefined
): SourceMetadata {
  const screeningType = screening.st?.trim() ?? "";
  const typeTitle = typeInfo?.title?.replace(/\s+/g, " ").trim() ?? "";
  const typeEvidence = [
    typeTitle,
    typeInfo?.popupTitle,
    typeInfo?.popupText,
    typeInfo?.booking_confirm_checkbox,
  ].filter(Boolean).join(" ");
  const message = screening.message?.replace(/\s+/g, " ").trim() ?? "";
  const soldOut = /\bsold out\b/i.test(message);
  const bookingUrl = !soldOut && screening.bookable
    ? sameSiteUrl(screening.link, "/tickets/")
    : null;

  let availabilityStatus: SourceMetadata["availabilityStatus"] = "unknown";
  if (soldOut) availabilityStatus = "sold_out";
  else if (screening.bookable && bookingUrl) availabilityStatus = "available";

  const accessibilityFeatures: SourceMetadata["accessibilityFeatures"] = [];
  const programmeTypes: SourceMetadata["programmeTypes"] = [];
  const screeningTags: SourceMetadata["screeningTags"] = [];

  if (screeningType === "EA" && /subtit|caption|hearing impaired/i.test(typeEvidence)) {
    accessibilityFeatures.push("captioned");
    screeningTags.push("subtitled");
  }
  if (screeningType === "BABY" && /Parent\s*(?:&|and)\s*Baby/i.test(typeEvidence)) {
    programmeTypes.push("parent_and_baby");
    if (/\bsubtitles\b/i.test(typeEvidence)) screeningTags.push("subtitled");
  }
  if (screeningType === "KC" && /Kids Club|accompanied by a child|children'?s cinema/i.test(typeEvidence)) {
    programmeTypes.push("child_required");
    screeningTags.push("family_friendly");
  }
  if (/\b\d+(?:st|nd|rd|th)\s+Anniversary\b/i.test(film.title)) screeningTags.push("anniversary");

  const screenNumber = screening.sn?.trim();
  return {
    filmTitleHint: cleanTitleHint(film.title, screeningType),
    releaseYear: parseReleaseYear(film.premiere),
    directors: splitDirectors(film.director),
    eventUrl: sameSiteUrl(film.link, "/film/"),
    artworkUrl: sameSiteUrl(film.image, "/wp-content/uploads/film/"),
    bookingUrl,
    screenName: screenNumber && /^\d+$/.test(screenNumber) ? `Screen ${Number(screenNumber)}` : null,
    projectionFormats: projectionFormats(typeTitle),
    accessibilityFeatures,
    programmeTypes,
    availabilityStatus,
    screeningLabel: typeTitle || null,
    screeningTags: Array.from(new Set(screeningTags)),
    soldOut,
  };
}
