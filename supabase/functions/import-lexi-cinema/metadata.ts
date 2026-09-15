import {
  availabilityFromSignals,
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseExplicitYear,
  parseRuntimeMinutes,
  type AccessibilityFeature,
  type ProgrammeType,
  type ScreeningTag,
} from "../_shared/screeningMetadata.ts";
import type { LexiEvent, LexiPerformance } from "./import-common.ts";

function clean(value?: string | null): string {
  return (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function displayTitle(event: LexiEvent): string {
  return clean(event.Title);
}

export function formatLabels(event: LexiEvent): string[] {
  return compactStrings((event.Tags ?? []).map((tag) => clean(tag.Format)));
}

export function seasonLabels(event: LexiEvent): string[] {
  return compactStrings((event.Seasons ?? [])
    .map((season) => clean(season.SeasonName))
    .filter((label) => label && !/^(?:Films|Main Features)$/i.test(label)));
}

function performanceSeasonLabels(event: LexiEvent, performance: LexiPerformance): string[] {
  const labels = seasonLabels(event);
  return labels.filter((label) => {
    if (/^(?:Brazilian Summer Nights|Spotlight:)/i.test(label)) return true;
    if (/^Q(?:&|&amp;)As? \+ Panels$/i.test(label)) {
      return performance.QA === "Y" || (event.Performances?.length ?? 0) === 1;
    }
    if (/^Baby-Friendly Screenings$/i.test(label)) return performance.BF === "Y";
    if (/^HOH Subtitled Screenings$/i.test(label)) return performance.HOH === "Y";
    if (/^Family Fun$/i.test(label)) return performance.FF === "Y";
    if (/^Talking Pictures$/i.test(label)) return performance.TP === "Y";
    return false;
  });
}

const FLAG_LABELS: ReadonlyArray<[keyof LexiPerformance, string]> = [
  ["BF", "Baby-Friendly Screenings"],
  ["FF", "Family Fun"],
  ["AD", "Audio Described"],
  ["HOH", "Hard of Hearing Subtitled"],
  ["RS", "Relaxed Screening"],
  ["QA", "Q+A"],
  ["AS", "Accessible Screenings"],
  ["BHS", "Black History Studies"],
  ["TP", "Talking Pictures"],
  ["OC", "Oscars Contenders"],
  ["SL", "Spotlight"],
  ["PR", "Preview"],
  ["LS", "Lexi Selects"],
  ["BR", "Summer Nights in Brazil"],
];

export function screeningLabels(event: LexiEvent, performance: LexiPerformance): string[] {
  return compactStrings([
    ...formatLabels(event),
    ...performanceSeasonLabels(event, performance),
    ...FLAG_LABELS.filter(([key]) => performance[key] === "Y").map(([, label]) => label),
    clean(performance.Notes),
  ]);
}

export function filmTitleHint(event: LexiEvent, performance: LexiPerformance): string | null {
  if (event.TypeDescription !== "Film" || !event.ID) return null;
  const seasons = seasonLabels(event).join(" ");
  let title = displayTitle(event);
  if (/Brazilian Summer Nights/i.test(seasons) || performance.BR === "Y") {
    title = title.replace(/^Brazilian Summer Nights\s*:\s*/i, "");
  }
  if (/Spotlight:/i.test(title) && /Spotlight:/i.test(seasons)) {
    title = title.replace(/^Spotlight\s*:\s*/i, "");
  }
  title = title
    .replace(/^Japanese Film Club\s*:\s*/i, "")
    .replace(/^Lexi Seniors['’] Film Club\s*:\s*/i, "")
    .replace(/^Fundraiser\s*:\s*/i, "")
    .replace(/\s*\(UK Premiere\)\s*$/i, "")
    .replace(/\s*\+\s*(?:(?:Recorded|Director|Live)\s+)?Q\s*(?:&|\+|and)\s*A\s*$/i, "")
    .trim();
  return title.length >= 2 ? title : null;
}

export function releaseYear(event: LexiEvent): number | null {
  return parseExplicitYear(event.Year);
}

export function runtimeMinutes(event: LexiEvent): number | null {
  return parseRuntimeMinutes(event.RunningTime);
}

export function directors(event: LexiEvent): string[] {
  return compactStrings(clean(event.Director).split(/\s*(?:,|;|\band\b)\s*/i));
}

export function countries(event: LexiEvent): string[] {
  return compactStrings(clean(event.Country).split(/\s*(?:,|;|\/|\band\b)\s*/i));
}

export function accessibility(performance: LexiPerformance): AccessibilityFeature[] {
  const values: AccessibilityFeature[] = [];
  if (performance.HOH === "Y") values.push("captioned");
  if (performance.AD === "Y") values.push("audio_described");
  if (performance.RS === "Y") values.push("relaxed");
  return values;
}

export function programmeTypes(performance: LexiPerformance): ProgrammeType[] {
  const values: ProgrammeType[] = [];
  if (performance.BF === "Y") values.push("parent_and_baby");
  if (performance.TP === "Y" || /Seniors['’] Film Club/i.test(clean(performance.Notes))) {
    values.push("seniors");
  }
  return values;
}

export function screeningTags(title: string, labels: ReadonlyArray<string>, performance: LexiPerformance): ScreeningTag[] {
  const tags = normaliseScreeningTags([title, ...labels]);
  if (performance.QA === "Y" && !tags.includes("q_and_a")) tags.push("q_and_a");
  if (performance.FF === "Y" && !tags.includes("family_friendly")) tags.push("family_friendly");
  if (performance.HOH === "Y" && !tags.includes("subtitled")) tags.push("subtitled");
  return tags;
}

export function legacyFormat(event: LexiEvent): string | null {
  return formatLabels(event).join(", ") || null;
}

export function bookingUrlForAvailability(
  sourceBookingUrl: string | null,
  soldOut: boolean,
): string | null {
  return soldOut ? null : sourceBookingUrl;
}

export function structuredMetadata(event: LexiEvent, performance: LexiPerformance, bookingUrl: string | null) {
  const labels = screeningLabels(event, performance);
  return {
    labels,
    projectionFormats: normaliseProjectionFormats(formatLabels(event)),
    accessibilityFeatures: accessibility(performance),
    programmeTypeValues: programmeTypes(performance),
    availabilityStatus: availabilityFromSignals({
      soldOut: performance.IsSoldOut === "Y",
      openForSale: performance.IsOpenForSale ?? null,
      hasBookingUrl: Boolean(bookingUrl),
    }),
  };
}
