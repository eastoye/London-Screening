import {
  availabilityFromSignals,
  compactStrings,
  normaliseProjectionFormats,
  normaliseScreeningTags,
  parseRuntimeMinutes,
  type AccessibilityFeature,
  type ProgrammeType,
} from "../_shared/screeningMetadata.ts";
import type { RichMixEvent, RichMixInstance } from "./source.ts";

const CERTIFICATE_RE = /\s*\((?:U|PG|12A?|15|18|R18|TBC|CERT(?:IFICATE)?\s*TBC)\)(?=\s*(?:[+&\[]|$))/i;

function clean(value: unknown): string {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

export function displayTitle(event: RichMixEvent): string {
  return clean(event.name);
}

export function filmTitleHint(event: RichMixEvent): string | null {
  let title = displayTitle(event).replace(CERTIFICATE_RE, "").replace(/\s+/g, " ").trim();
  if (!title || /\b(?:shorts?|double[ -]bill|awards?|programme|showcase|mixtape)\b/i.test(title)) return null;
  title = title
    .replace(/^(?:Premiere|Black In Season)\s*:\s*/i, "")
    .replace(/^Counterpoints Arts\s+Presents\s+(?:UK\s+)?Premiere\s*:\s*/i, "")
    .replace(/^Dailies\s+Presents\s*:\s*/i, "")
    .replace(/^(?:Film Africa Festival|London Migration Film Festival|Queer East|SXSW|Film East|Fight the Power)\s*\d{0,4}\s*:\s*/i, "")
    .replace(/\s*(?:\+|&)(?:\s*Director['’]?s?)?\s*Q\s*&\s*A\s*$/i, "")
    .replace(/\s*(?:\+|&)\s*Intro(?:duction)?\s*$/i, "")
    .replace(CERTIFICATE_RE, "")
    .replace(/\s+/g, " ").trim();
  return title.length >= 2 ? title : null;
}

export function runtimeMinutes(event: RichMixEvent): number | null {
  return parseRuntimeMinutes(event.duration);
}

function explicitPresentationLabels(event: RichMixEvent): string[] {
  const title = clean(event.name);
  const labels: string[] = [];
  if (/\bQ\s*&\s*A\b/i.test(title)) labels.push("Q&A");
  if (/\bIntro(?:duction)?\b/i.test(title)) labels.push("Introduction");
  if (/\bPremiere\b/i.test(title)) labels.push("Premiere");
  if (/\bDouble[ -]Bill\b/i.test(title)) labels.push("Double Bill");
  const format = title.match(/\b(?:35\s*mm|70\s*mm|IMAX|4K|DCP)\b/i)?.[0];
  if (format) labels.push(format.replace(/\s+/g, ""));
  if (/^cinema\+$/i.test(clean(event.attributes.attribute_COGFirstCategory))) labels.push("Cinema+");
  return labels;
}

export function screeningLabels(event: RichMixEvent, instance: RichMixInstance): string[] {
  const access = clean(instance.attributes.attribute_Access);
  return compactStrings([
    ...explicitPresentationLabels(event),
    instance.attributes.attribute_MembersOnlyScreening === true ? "Members Only" : null,
    access || null,
  ]);
}

export function legacyFormat(event: RichMixEvent): string | null {
  const labels = explicitPresentationLabels(event).filter((label) => /^(?:35mm|70mm|IMAX|4K|DCP)$/i.test(label));
  return labels.join(", ") || null;
}

export function structuredMetadata(event: RichMixEvent, instance: RichMixInstance, bookingUrl: string) {
  const labels = screeningLabels(event, instance);
  const accessText = clean(instance.attributes.attribute_Access);
  const accessibility: AccessibilityFeature[] = [];
  if (/caption|subtit/i.test(accessText)) accessibility.push("captioned");
  if (/audio[ -]?describ/i.test(accessText)) accessibility.push("audio_described");
  if (/relaxed/i.test(accessText)) accessibility.push("relaxed");
  const programmes: ProgrammeType[] = [];
  if (instance.attributes.attribute_MembersOnlyScreening === true) programmes.push("members_only");
  const soldOut = false; // Spektrix exposes on-sale state here, not a reliable sold-out signal.
  return {
    labels,
    projectionFormats: normaliseProjectionFormats(explicitPresentationLabels(event)),
    accessibility,
    programmes,
    screeningTags: normaliseScreeningTags(labels),
    availability: availabilityFromSignals({
      soldOut,
      openForSale: instance.isOnSale,
      hasBookingUrl: Boolean(bookingUrl),
    }),
    soldOut,
  };
}

export function screenName(event: RichMixEvent): string | null {
  const value = clean(event.attributes.attribute_VENUE);
  return /^screen\s+\d+$/i.test(value) ? value.replace(/^screen/i, "Screen") : null;
}
