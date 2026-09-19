import {
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseExplicitYear,
  parseRuntimeMinutes,
  type AccessibilityFeature,
  type ProgrammeType,
  type ScreeningTag,
} from "../_shared/screeningMetadata.ts";
import type { RegentBadge, RegentMovie, RegentShowing } from "./import-common.ts";

const COUNTRY_NAMES: Record<string, string> = {
  AR: "Argentina", AU: "Australia", AT: "Austria", BD: "Bangladesh",
  BE: "Belgium", BR: "Brazil", CA: "Canada", CL: "Chile", CN: "China",
  CO: "Colombia", CZ: "Czech Republic", DK: "Denmark", EG: "Egypt",
  FI: "Finland", FR: "France", DE: "Germany", GR: "Greece",
  HK: "Hong Kong", HU: "Hungary", IN: "India", ID: "Indonesia",
  IR: "Iran", IE: "Ireland", IL: "Israel", IT: "Italy", JP: "Japan",
  KR: "South Korea", MX: "Mexico", MY: "Malaysia", NL: "Netherlands",
  NZ: "New Zealand", NG: "Nigeria", NO: "Norway", PK: "Pakistan",
  PH: "Philippines", PL: "Poland", PT: "Portugal", RO: "Romania",
  RU: "Russia", SA: "Saudi Arabia", ZA: "South Africa", ES: "Spain",
  SE: "Sweden", CH: "Switzerland", TW: "Taiwan", TH: "Thailand",
  TR: "Turkey", UA: "Ukraine", AE: "United Arab Emirates",
  GB: "United Kingdom", US: "United States", VN: "Vietnam",
};

function badgeText(badge: RegentBadge): string {
  return badge.title?.trim() || badge.displayName?.trim() || "";
}

function meaningfulBadges(movie: RegentMovie, showing: RegentShowing): string[] {
  return compactStrings([
    ...(movie.showingBadges ?? []).map(badgeText),
    ...(showing.showingBadges ?? []).map(badgeText),
    ...(showing.additionalShowingBadges ?? []).map(badgeText),
  ]).filter((label) => !/^reserved seating$/i.test(label));
}

function titleLabels(title: string): string[] {
  const labels: string[] = [];
  if (/\bQ\s*(?:&|\+)\s*A\b/i.test(title)) labels.push("Q&A");
  if (/\bintro(?:duction)?\b/i.test(title)) labels.push("Introduction");
  if (/\blive organ\b/i.test(title)) labels.push("Live Organ");
  if (/\blive (?:music|score|accompaniment)\b/i.test(title)) labels.push("Live Music");
  if (/\b(?:UK|London|world|international) premiere\b/i.test(title)) {
    labels.push(title.match(/\b(?:UK|London|world|international) premiere\b/i)?.[0] ?? "Premiere");
  }
  if (/\bpreview\b/i.test(title)) labels.push("Preview");
  if (/\banniversary\b/i.test(title)) labels.push("Anniversary");
  if (/\brelaxed(?: screening)?\b/i.test(title)) labels.push("Relaxed Screening");
  return compactStrings(labels);
}

export function explicitLabels(movie: RegentMovie, showing: RegentShowing): string[] {
  return compactStrings([...meaningfulBadges(movie, showing), ...titleLabels(movie.name)]);
}

function hasSingleFilmEvidence(movie: RegentMovie): boolean {
  if (movie.tmdbId?.trim()) return true;
  return Boolean(movie.directedBy?.trim() && movie.releaseDate && (movie.genre?.trim() || movie.duration));
}

export function filmTitleHint(movie: RegentMovie): string | null {
  const title = movie.name.replace(/\s+/g, " ").trim();
  if (!title || !hasSingleFilmEvidence(movie)) return null;
  if (/\b(?:roundtables?|workshops?|reading groups?|networking|quiz|talks?)\b/i.test(title)) return null;

  let hint = title
    .replace(/^.*?\bspecial screening of\s+/i, "")
    .replace(/^.*?\bopening gala film\s*:\s*/i, "")
    .replace(/\s+\+\s+(?:Q\s*(?:&|\+)\s*A|intro(?:duction)?|live organ|live music|live score|live accompaniment|panel discussion|discussion|reception)\b[\s\S]*$/i, "")
    .trim();
  if (!hint || hint.length < 2) return null;
  return hint;
}

export function releaseYear(movie: RegentMovie): number | null {
  return movie.releaseDate ? parseExplicitYear(movie.releaseDate) : null;
}

export function runtimeMinutes(movie: RegentMovie): number | null {
  return parseRuntimeMinutes(movie.duration);
}

export function directors(movie: RegentMovie): string[] {
  return compactStrings((movie.directedBy ?? "").split(/\s*(?:,|;|\band\b|&)\s*/i));
}

export function countries(movie: RegentMovie): string[] {
  return compactStrings((movie.countryOfOrigin ?? "").split(/\s*(?:,|;|\/|\band\b|&)\s*/i))
    .map((country) => COUNTRY_NAMES[country.toUpperCase()] ?? country);
}

export function accessibility(labels: ReadonlyArray<string>): AccessibilityFeature[] {
  const text = labels.join(" ");
  const values: AccessibilityFeature[] = [];
  if (/\bopen captions?\b|\bOC\b|\bcaptioned\b/i.test(text)) values.push("captioned");
  if (/\baudio[ -](?:described|description)\b|\bAD\b/i.test(text)) values.push("audio_described");
  if (/\brelaxed\b/i.test(text)) values.push("relaxed");
  return values;
}

export function programmeTypes(labels: ReadonlyArray<string>): ProgrammeType[] {
  const text = labels.join(" ");
  const values: ProgrammeType[] = [];
  if (/\bmembers?(?:'|’)\s+only\b|\bmembers[- ]only\b/i.test(text)) values.push("members_only");
  if (/\bparent\s*(?:&|and)\s*baby\b|\bbaby\s*(?:&|and)\s*carer\b/i.test(text)) values.push("parent_and_baby");
  if (/\bchild required\b|\bchildren must be accompanied\b/i.test(text)) values.push("child_required");
  if (/\bseniors?\s+only\b/i.test(text)) values.push("seniors");
  return values;
}

export function screeningTags(labels: ReadonlyArray<string>): ScreeningTag[] {
  const tags = normaliseScreeningTags(labels);
  if (/\blive organ\b/i.test(labels.join(" ")) && !tags.includes("live_music")) tags.push("live_music");
  return tags;
}

export function legacyFormat(labels: ReadonlyArray<string>): string | null {
  const text = labels.join(" ");
  const formats: string[] = [];
  if (/\b35\s*mm\b/i.test(text)) formats.push("35mm");
  if (/\b70\s*mm\b/i.test(text)) formats.push("70mm");
  if (/\b4K\b/i.test(text)) formats.push("4K");
  if (/\bIMAX\b/i.test(text)) formats.push("IMAX");
  if (/\b3D\b/i.test(text)) formats.push("3D");
  if (/\bDCP\b/i.test(text)) formats.push("DCP");
  if (/\bDolby Atmos\b/i.test(text)) formats.push("Dolby Atmos");
  return compactStrings(formats).join(", ") || null;
}

export function projectionFormats(labels: ReadonlyArray<string>) {
  return normaliseProjectionFormats(labels);
}

export function isSoldOut(showing: RegentShowing): boolean {
  return typeof showing.seatsRemaining === "number" && showing.seatsRemaining <= 0;
}

export function availabilityStatus(showing: RegentShowing): "available" | "sold_out" | "unknown" {
  if (isSoldOut(showing)) return "sold_out";
  if (typeof showing.seatsRemaining === "number" && showing.seatsRemaining > 0) return "available";
  return "unknown";
}
