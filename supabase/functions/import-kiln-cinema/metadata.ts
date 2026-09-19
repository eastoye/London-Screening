import {
  availabilityFromSignals,
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseExplicitYear,
  type AccessibilityFeature,
  type ProgrammeType,
} from "../_shared/screeningMetadata.ts";
import type { KilnEvent, KilnInstance } from "./source.ts";

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function displayTitle(event: KilnEvent): string {
  return clean(event.name);
}

export function filmTitleHint(event: KilnEvent): string | null {
  let title = displayTitle(event);
  if (!title) return null;

  if (/^NT Live:/i.test(title) || /^Scottish Ballet:/i.test(title) ||
      /\bThe Play\b/i.test(title) || /^Hadestown$/i.test(title) ||
      /\bSelection of Short Films\b/i.test(title) || /^Somali Film Festival:/i.test(title)) {
    return null;
  }

  title = title
    .replace(/^Jim Carter presents:\s*/i, "")
    .replace(/\s*(?:\+|&)\s*Q\s*&\s*A\b[\s\S]*$/i, "")
    .replace(/\s+\d+(?:st|nd|rd|th)\s+Anniversary\s+Screening\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return title.length >= 2 ? title : null;
}

export function sourceReleaseYear(event: KilnEvent): number | null {
  const hint = filmTitleHint(event);
  if (!hint) return null;
  return parseExplicitYear(clean(event.description).slice(0, 80));
}

export function sourceRuntimeMinutes(event: KilnEvent): number | null {
  if (!filmTitleHint(event)) return null;
  return Number.isInteger(event.duration) && event.duration > 0 && event.duration <= 1440
    ? event.duration
    : null;
}

function accessPerformance(instance: KilnInstance): string {
  return clean(instance.attributes.attribute_AccessPerformance);
}

function explicitPresentationLabels(event: KilnEvent, instance: KilnInstance): string[] {
  const title = displayTitle(event);
  const descriptionPrefix = clean(event.description).slice(0, 100);
  const labels: string[] = [];
  const access = accessPerformance(instance);
  if (access) labels.push(access);
  if (/\bQ\s*&\s*A\b/i.test(title) || /\bQ\s*(?:&|and)\s*A\b/i.test(descriptionPrefix) || /\bQ\s+and\s+A\b/i.test(access)) {
    labels.push("Q&A");
  }
  if (/\bAnniversary\b/i.test(title)) labels.push("Anniversary");
  if (/^Preview\b/i.test(descriptionPrefix)) labels.push("Preview");
  return compactStrings(labels);
}

function explicitFormatLabels(event: KilnEvent): string[] {
  const labels: string[] = [];
  const sourceFormat = clean(event.attributes.attribute_Format);
  if (sourceFormat) labels.push(sourceFormat);
  const titleFormat = displayTitle(event).match(/\b(?:35\s*mm|70\s*mm|IMAX)\b/i)?.[0];
  if (titleFormat) labels.push(titleFormat);
  return compactStrings(labels);
}

export function legacyFormat(event: KilnEvent): string | null {
  const formats = normaliseProjectionFormats(explicitFormatLabels(event));
  const display = formats.map((format) => format === "imax" ? "IMAX" : format);
  return display.join(", ") || null;
}

export function structuredMetadata(event: KilnEvent, instance: KilnInstance, booking: string) {
  const labels = explicitPresentationLabels(event, instance);
  const access = accessPerformance(instance);
  const accessibility: AccessibilityFeature[] = [];
  if (/^Captioned (?:Performance|Screening)$/i.test(access)) accessibility.push("captioned");
  if (/^Audio[ -]?Described (?:Performance|Screening)$/i.test(access)) accessibility.push("audio_described");
  if (/^Relaxed (?:Performance|Screening)$/i.test(access)) accessibility.push("relaxed");

  const programmes: ProgrammeType[] = [];
  if (/^Parent and Baby Screening$/i.test(access)) programmes.push("parent_and_baby");
  if (/^Members(?:'|’)? (?:Only )?Screening$/i.test(access)) programmes.push("members_only");
  if (/^Child Required/i.test(access)) programmes.push("child_required");
  if (/^Seniors?(?:'|’)? (?:Only )?Screening$/i.test(access)) programmes.push("seniors");

  // Kiln's API exposes on-sale state, but not a reliable explicit sold-out flag.
  // Keep sold_out false rather than interpreting off-sale as sold out.
  const soldOut = false;
  return {
    labels,
    projectionFormats: normaliseProjectionFormats(explicitFormatLabels(event)),
    accessibility,
    programmes,
    screeningTags: normaliseScreeningTags(labels),
    availability: availabilityFromSignals({
      soldOut,
      openForSale: instance.isOnSale,
      hasBookingUrl: Boolean(booking),
    }),
    soldOut,
  };
}
