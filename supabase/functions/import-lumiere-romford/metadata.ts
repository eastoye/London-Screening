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
import type { CineSyncMovie, CineSyncShowtime, CineSyncTag } from "./import-common.ts";

function tagName(tag: CineSyncTag): string {
  return tag.name?.replace(/\s+/g, " ").trim() || "";
}

export function movieTagNames(movie: CineSyncMovie): string[] {
  return compactStrings((movie.movie_tags ?? []).map(tagName));
}

export function explicitLabels(movie: CineSyncMovie, show: CineSyncShowtime): string[] {
  const labels = [
    show.theater_experience_name,
    ...movieTagNames(movie),
    ...(show.screen_tags ?? []).map(tagName),
    ...(show.show_times_tags ?? []).map(tagName),
  ];
  if (show.member_only === true) labels.push("Members only");
  if (show.subscriber_only === true) labels.push("Subscribers only");
  return compactStrings(labels);
}

const NON_FILM_TAGS = new Set([
  "arts, crafts and mindfulness",
  "baby classes",
  "ballet and opera",
  "big screen musicals",
  "event cinema",
  "exhibition on screen",
  "food and drink events",
  "fundraising event",
  "national theatre live",
  "quiz night at lumiere",
]);

export function exclusionReason(movie: CineSyncMovie, show: CineSyncShowtime): string | null {
  if (movie.type !== "movie") return "non_movie_type";
  // These products use an external checkout and CineSync's time can be doors or
  // whole-event time rather than the actual film start. V1 already excluded them.
  if (show.is_this_sold_by_third_party_system === "1") return "external_event_time_unreliable";
  const blockedTag = movieTagNames(movie).find((tag) => NON_FILM_TAGS.has(tag.toLowerCase()));
  return blockedTag ? `non_film_tag:${blockedTag}` : null;
}

function isCompilationOrUnknownProgramme(movie: CineSyncMovie): boolean {
  const tags = movieTagNames(movie).join(" ");
  const title = movie.movie_name ?? "";
  return /\bMarathons?\s*(?:&|and)\s*All-Dayers?\b/i.test(tags)
    || /\b(?:marathon|all-day|film festival|mystery screening|secret classic)\b/i.test(title)
    || /\bBreakaway Day\s*(?:&|and)\s*Metamorph\b/i.test(title)
    || /\bClassic Doctor Who\b/i.test(tags);
}

export function filmTitleHint(movie: CineSyncMovie): string | null {
  if (movie.type !== "movie" || !movie.movie_id || isCompilationOrUnknownProgramme(movie)) return null;
  const hasFilmEvidence = Boolean(
    parseExplicitYear(movie.movie_year)
      || (movie.directed_by ?? []).some((director) => director.name?.trim()),
  );
  if (!hasFilmEvidence) return null;
  let title = movie.movie_name?.replace(/\s+/g, " ").trim() ?? "";
  title = title
    .replace(/\s*:\s*(?:Steven Spielberg|The Hunger Games) season\s*$/i, "")
    .replace(/\s*[-:]\s*(?:the )?(?:director(?:'s)?|final) cut(?:\s*\([^)]*anniversary\))?\s*$/i, "")
    .replace(/\s*[-:]\s*\d+(?:st|nd|rd|th) anniversary\s*$/i, "")
    .replace(/\s*:\s*4K restoration\s*$/i, "")
    .replace(/\s*-\s*one show only with (?:recorded|live) Q\s*(?:&|\+|and)\s*A\s*$/i, "")
    .replace(/\s+plus cinema-exclusive interview\s*$/i, "")
    .replace(/\s+encore\s*$/i, "")
    .replace(/\s*-\s*the madness film\s*$/i, "")
    .trim();
  return title.length >= 2 ? title : null;
}

export function releaseYear(movie: CineSyncMovie): number | null {
  return parseExplicitYear(movie.movie_year);
}

export function runtimeMinutes(movie: CineSyncMovie): number | null {
  const text = String(movie.duration ?? "").trim();
  const compact = text.match(/^(\d{1,2})\s*h(?:ours?)?\s*(?:(\d{1,3})\s*m(?:in(?:ute)?s?)?)?$/i);
  if (compact) {
    const total = Number(compact[1]) * 60 + Number(compact[2] ?? 0);
    return total > 0 && total <= 1440 ? total : null;
  }
  return parseRuntimeMinutes(movie.duration);
}

export function directors(movie: CineSyncMovie): string[] {
  return compactStrings((movie.directed_by ?? []).map((director) => director.name));
}

export function countries(movie: CineSyncMovie): string[] {
  return compactStrings((movie.movie_countries ?? "").split(/\s*(?:,|;|\/|\band\b)\s*/i));
}

export function accessibility(labels: ReadonlyArray<string>): AccessibilityFeature[] {
  const text = labels.join(" ");
  const values: AccessibilityFeature[] = [];
  if (/\b(?:captioned|open captions?|HOH|hard of hearing|SDH)\b/i.test(text)) values.push("captioned");
  if (/\baudio[ -](?:described|description)\b/i.test(text)) values.push("audio_described");
  if (/\brelaxed\b/i.test(text)) values.push("relaxed");
  return values;
}

export function programmeTypes(show: CineSyncShowtime, labels: ReadonlyArray<string>): ProgrammeType[] {
  const text = labels.join(" ");
  const values: ProgrammeType[] = [];
  if (show.member_only === true || /\bmembers? only\b/i.test(text)) values.push("members_only");
  if (/\bparent\s*(?:&|and)\s*baby\b|\bbaby\s*(?:&|and)\s*carer\b/i.test(text)) values.push("parent_and_baby");
  if (/\bchild required\b|\bchildren must be accompanied\b/i.test(text)) values.push("child_required");
  if (/\bseniors? only\b|\bsilver screening\b/i.test(text)) values.push("seniors");
  return values;
}

export function screeningTags(labels: ReadonlyArray<string>): ScreeningTag[] {
  const tags = normaliseScreeningTags(labels);
  const text = labels.join(" ");
  if (/\bQ\s*(?:&|\+|and)\s*A\b/i.test(text) && !tags.includes("q_and_a")) tags.push("q_and_a");
  if (/\bhard of hearing subtitles?\b|\boriginal language with English subs?\b|\bwith subtitles?\b/i.test(text) && !tags.includes("subtitled")) tags.push("subtitled");
  return tags;
}

export function legacyFormat(labels: ReadonlyArray<string>): string | null {
  const text = labels.join(" ");
  const formats: string[] = [];
  if (/\bDigital Cinema\b/i.test(text)) formats.push("Digital Cinema");
  if (/\b35\s*mm\b/i.test(text)) formats.push("35mm");
  if (/\b70\s*mm\b/i.test(text)) formats.push("70mm");
  if (/\b4K\b/i.test(text)) formats.push("4K");
  if (/\bIMAX\b/i.test(text)) formats.push("IMAX");
  return compactStrings(formats).join(", ") || null;
}

export function projectionFormats(labels: ReadonlyArray<string>) {
  return normaliseProjectionFormats(labels);
}

export function availability(movie: CineSyncMovie, show: CineSyncShowtime, hasBookingUrl: boolean) {
  if (show.sold_out === true) return { soldOut: true, status: "sold_out" as const };
  if (movie.is_booking_open === true && hasBookingUrl) return { soldOut: false, status: "available" as const };
  return { soldOut: false, status: "unknown" as const };
}
