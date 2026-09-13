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
import { cleanHtml, decodeHtml } from "./import-common.ts";

export interface IcaPageMetadata {
  artworkUrl: string | null;
  colophonText: string;
  detailText: string;
  filmTitleHint: string | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  directors: string[];
  countries: string[];
}

const COUNTRY_NAMES = [
  "United Kingdom", "South Korea", "United States", "Argentina", "Australia",
  "Austria", "Belgium", "Brazil", "Canada", "Chile", "China", "Colombia",
  "Cuba", "Czech Republic", "Denmark", "Egypt", "Finland", "France",
  "Germany", "Greece", "Hong Kong", "Hungary", "Iceland", "India",
  "Indonesia", "Iran", "Ireland", "Israel", "Italy", "Japan", "Lebanon",
  "Mexico", "Morocco", "Netherlands", "New Zealand", "Nigeria", "Norway",
  "Palestine", "Peru", "Philippines", "Poland", "Portugal", "Romania",
  "Russia", "Senegal", "Serbia", "Singapore", "Slovakia", "Slovenia",
  "South Africa", "Spain", "Sweden", "Switzerland", "Taiwan", "Thailand",
  "Tunisia", "Turkey", "Ukraine", "Uruguay", "Venezuela", "Vietnam",
  "UK", "USA", "US",
] as const;

const COUNTRY_PATTERN = COUNTRY_NAMES
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .sort((a, b) => b.length - a.length)
  .join("|");
const COUNTRY_GROUP = `(?:${COUNTRY_PATTERN})`;

function absoluteIcaUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value, "https://www.ica.art").toString();
  } catch {
    return null;
  }
}

function normaliseComparable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitCountries(value: string): string[] {
  return compactStrings(value.split(/\s*(?:\/|,|;|\band\b)\s*/i)).map((country) => {
    if (/^uk$/i.test(country)) return "United Kingdom";
    if (/^(?:us|usa)$/i.test(country)) return "USA";
    return country;
  });
}

function parseColophon(displayTitle: string, colophonHtml: string): Omit<IcaPageMetadata, "artworkUrl" | "detailText" | "colophonText"> {
  const colophonText = cleanHtml(colophonHtml);
  const italicTitles = [...colophonHtml.matchAll(/<i\b[^>]*>([\s\S]*?)<\/i>/gi)]
    .map((match) => cleanHtml(match[1]))
    .filter(Boolean);
  const firstText = cleanHtml(colophonHtml.split(/<\/?i\b[^>]*>/i)[0]);
  const candidate = italicTitles[0] || firstText.split(/,?\s+dir\./i)[0].trim();
  const displayComparable = normaliseComparable(displayTitle);
  const candidateComparable = normaliseComparable(candidate);
  const unsafeProgramme = /\b(?:films?|shorts?|retrospective|programme|compilation|showcase)\b/i.test(displayTitle);
  const filmTitleHint = candidateComparable && displayComparable.includes(candidateComparable) && !unsafeProgramme
    ? candidate
    : null;

  if (!filmTitleHint) {
    return { filmTitleHint: null, releaseYear: null, runtimeMinutes: null, directors: [], countries: [] };
  }

  const releaseYear = parseExplicitYear(colophonText);
  const runtimeText = colophonText.match(/\b\d{1,3}\s*(?:minutes?|mins?|min\.)\b/i)?.[0] ?? null;
  const runtimeMinutes = parseRuntimeMinutes(runtimeText);
  const dirMarker = /\bdir\.\s*/i.exec(colophonText);
  let directors: string[] = [];
  let countries: string[] = [];

  if (releaseYear) {
    const yearIndex = colophonText.indexOf(String(releaseYear));
    const beforeYear = colophonText.slice(0, yearIndex).trim();
    const afterYear = colophonText.slice(yearIndex + 4).trim();
    const beforeCountry = beforeYear.match(new RegExp(`(${COUNTRY_GROUP}(?:\\s*(?:/|,|;|and)\\s*${COUNTRY_GROUP})*)$`, "i"));
    const afterCountry = afterYear.match(new RegExp(`^\\s*(${COUNTRY_GROUP}(?:\\s*(?:/|,|;|and)\\s*${COUNTRY_GROUP})*)`, "i"));
    const countryText = beforeCountry?.[1] ?? afterCountry?.[1] ?? "";
    countries = splitCountries(countryText);

    if (dirMarker) {
      const directorStart = dirMarker.index + dirMarker[0].length;
      const directorEnd = beforeCountry
        ? beforeYear.length - beforeCountry[0].length
        : yearIndex;
      directors = compactStrings(
        colophonText.slice(directorStart, directorEnd).replace(/[,\s]+$/, "").split(/\s*(?:,|\band\b|&)\s*/i)
      );
    }
  }

  return { filmTitleHint, releaseYear, runtimeMinutes, directors, countries };
}

export function parseIcaMetadata(displayTitle: string, html: string): IcaPageMetadata {
  const colophonHtml = html.match(/<div id=["']colophon["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
  const colophonText = cleanHtml(colophonHtml);
  const detailHtml = html.match(/<div id=["']detail-body["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div id=["']detail-side["']/i)?.[1] ?? "";
  const detailText = cleanHtml(detailHtml);
  const image = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<div id=["']films-image["'][\s\S]*?<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1]
    ?? null;
  const parsed = parseColophon(displayTitle, colophonHtml);
  return {
    artworkUrl: absoluteIcaUrl(image ? decodeHtml(image) : null),
    colophonText,
    detailText,
    ...parsed,
  };
}

function datedContext(detailText: string, startTime: string): string {
  const date = new Date(startTime);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric" }).format(date);
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", month: "long" }).format(date);
  const pattern = new RegExp(`.{0,120}\\b${day}(?:st|nd|rd|th)?\\s+${month}\\b.{0,180}`, "i");
  return detailText.match(pattern)?.[0] ?? "";
}

export function explicitPerformanceLabels({
  displayTitle,
  metadata,
  startTime,
  performanceCount,
  instanceLabels,
}: {
  displayTitle: string;
  metadata: IcaPageMetadata;
  startTime: string;
  performanceCount: number;
  instanceLabels: string[];
}): string[] {
  const labels: string[] = [...instanceLabels];
  // A colophon can describe only one component of a programme. Use its
  // presentation wording only when that component is also a safe film hint.
  const versionText = metadata.filmTitleHint
    ? `${displayTitle} ${metadata.colophonText}`
    : displayTitle;
  const format = versionText.match(/\b(?:35|70)\s*mm\b|\bIMAX\b|\b4K(?:\s+Restoration)?\b/i)?.[0];
  if (format) labels.push(format);
  if (/\brestor(?:ation|ed)\b/i.test(displayTitle)) labels.push("Restoration");
  if (/\bEnglish subtitles\b/i.test(metadata.colophonText)) labels.push("English subtitles");

  const scopedText = performanceCount === 1
    ? `${displayTitle} ${metadata.detailText}`
    : datedContext(metadata.detailText, startTime);
  if (/\bQ\s*(?:&|\+)\s*A\b|\bquestions?\s+and\s+answers?\b/i.test(scopedText)) labels.push("Q&A");
  if (/\bintro(?:duction)?\b/i.test(scopedText)) labels.push("Introduction");
  if (/\bpanel discussion\b/i.test(scopedText)) labels.push("Panel discussion");
  if (/\b(?:UK|London|world|international) premiere\b/i.test(scopedText)) {
    labels.push(scopedText.match(/\b(?:UK|London|world|international) premiere\b/i)?.[0] ?? "Premiere");
  }
  if (/\bpreview screening\b/i.test(scopedText)) labels.push("Preview screening");
  return compactStrings(labels);
}

export function icaProjectionFormats(labels: ReadonlyArray<string>) {
  return normaliseProjectionFormats(labels);
}

export function icaAccessibility(labels: ReadonlyArray<string>): AccessibilityFeature[] {
  const text = labels.join(" ");
  const result: AccessibilityFeature[] = [];
  if (/\bcaption(?:ed|s)?\b/i.test(text)) result.push("captioned");
  if (/\baudio[ -](?:described|description)\b|\bAD\b/i.test(text)) result.push("audio_described");
  if (/\brelaxed\b/i.test(text)) result.push("relaxed");
  return result;
}

export function icaProgrammeTypes(labels: ReadonlyArray<string>): ProgrammeType[] {
  const text = labels.join(" ");
  const result: ProgrammeType[] = [];
  if (/\bmembers?(?:'|’)\s+only\b|\bmembers[- ]only\b/i.test(text)) result.push("members_only");
  if (/\bparent\s*(?:&|and)\s*baby\b|\bbaby\s*(?:&|and)\s*carer\b/i.test(text)) result.push("parent_and_baby");
  if (/\bchild required\b|\bchildren must be accompanied\b/i.test(text)) result.push("child_required");
  if (/\bseniors?\b/i.test(text)) result.push("seniors");
  return result;
}

export function icaScreeningTags(labels: ReadonlyArray<string>): ScreeningTag[] {
  const tags = normaliseScreeningTags(labels);
  if (!tags.includes("no_adverts")) tags.push("no_adverts");
  return tags;
}

export function legacyFormat(labels: ReadonlyArray<string>): string | null {
  const values: string[] = [];
  const text = labels.join(" ");
  for (const value of ["35mm", "70mm", "IMAX", "4K"]) {
    if (new RegExp(`\\b${value.replace("mm", "\\s*mm")}\\b`, "i").test(text)) values.push(value);
  }
  return compactStrings(values).join(", ") || null;
}
