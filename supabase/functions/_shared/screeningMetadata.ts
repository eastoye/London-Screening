export const PROJECTION_FORMATS = ["35mm", "70mm", "imax"] as const;
export const ACCESSIBILITY_FEATURES = [
  "captioned",
  "audio_described",
  "relaxed",
] as const;
export const PROGRAMME_TYPES = [
  "members_only",
  "parent_and_baby",
  "child_required",
  "seniors",
] as const;
export const AVAILABILITY_STATUSES = [
  "available",
  "sold_out",
  "unknown",
] as const;
export const SCREENING_TAGS = [
  "q_and_a",
  "introduction",
  "discussion",
  "premiere",
  "preview",
  "anniversary",
  "double_bill",
  "live_music",
  "singalong",
  "no_adverts",
  "family_friendly",
  "send_friendly",
  "subtitled",
  "dubbed",
  "rerelease",
  "restoration",
] as const;

export type ProjectionFormat = (typeof PROJECTION_FORMATS)[number];
export type AccessibilityFeature = (typeof ACCESSIBILITY_FEATURES)[number];
export type ProgrammeType = (typeof PROGRAMME_TYPES)[number];
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];
export type ScreeningTag = (typeof SCREENING_TAGS)[number];

export function compactStrings(
  values: ReadonlyArray<string | null | undefined>
): string[] {
  return Array.from(
    new Set(values.map((value) => value?.replace(/\s+/g, " ").trim()).filter(Boolean) as string[])
  );
}

export function parseExplicitYear(value: string | number | null | undefined): number | null {
  const match = String(value ?? "").match(/(?:^|\D)((?:18|19|20|21)\d{2})(?:\D|$)/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1888 && year <= 2200 ? year : null;
}

export function parseRuntimeMinutes(value: string | number | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 && value <= 1440 ? value : null;
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  const hours = text.match(/\b(\d{1,2})\s*(?:hours?|hrs?|hr)\b/i)?.[1];
  const minutes = text.match(/\b(\d{1,3})\s*(?:minutes?|mins?|min)\b/i)?.[1];
  const total = (hours ? Number(hours) * 60 : 0) + (minutes ? Number(minutes) : 0);
  if (total > 0 && total <= 1440) return total;
  if (/^\d{1,4}$/.test(text)) {
    const numeric = Number(text);
    return numeric > 0 && numeric <= 1440 ? numeric : null;
  }
  return null;
}

export function normaliseScreeningTags(
  explicitLabels: ReadonlyArray<string | null | undefined>
): ScreeningTag[] {
  const text = explicitLabels.filter(Boolean).join(" ");
  const found = new Set<ScreeningTag>();
  if (/\bQ\s*(?:&|\+)\s*A\b|\bquestions?\s+and\s+answers?\b/i.test(text)) found.add("q_and_a");
  if (/\bintro(?:duction)?\b/i.test(text)) found.add("introduction");
  if (/\bdiscussion\b/i.test(text)) found.add("discussion");
  if (/\bpremiere\b/i.test(text)) found.add("premiere");
  if (/\bpreview\b/i.test(text)) found.add("preview");
  if (/\banniversary\b/i.test(text)) found.add("anniversary");
  if (/\bdouble[ -]bill\b/i.test(text)) found.add("double_bill");
  if (/\blive music\b|\blive score\b|\blive accompaniment\b/i.test(text)) found.add("live_music");
  if (/\bsing[ -]?along\b/i.test(text)) found.add("singalong");
  if (/\bno (?:ads|adverts|trailers)\b/i.test(text)) found.add("no_adverts");
  if (/\bfamily friendly\b/i.test(text)) found.add("family_friendly");
  if (/\bSEND friendly\b/i.test(text)) found.add("send_friendly");
  if (/\bsubtit(?:led|les)\b/i.test(text)) found.add("subtitled");
  if (/\bdubbed\b/i.test(text)) found.add("dubbed");
  if (/\brerelease\b|\bre-release\b/i.test(text)) found.add("rerelease");
  if (/\brestoration\b|\brestored\b/i.test(text)) found.add("restoration");
  return SCREENING_TAGS.filter((tag) => found.has(tag));
}

// Callers must pass explicit source labels, not film titles or inferred text.
export function normaliseProjectionFormats(
  explicitLabels: ReadonlyArray<string | null | undefined>
): ProjectionFormat[] {
  const found = new Set<ProjectionFormat>();

  for (const label of explicitLabels) {
    if (!label) continue;
    if (/\b35\s*mm\b/i.test(label)) found.add("35mm");
    if (/\b70\s*mm\b/i.test(label)) found.add("70mm");
    if (/\bIMAX\b/i.test(label)) found.add("imax");
  }

  return PROJECTION_FORMATS.filter((format) => found.has(format));
}

export function availabilityFromSignals({
  soldOut,
  openForSale,
  hasBookingUrl,
}: {
  soldOut: boolean;
  openForSale: boolean | null;
  hasBookingUrl: boolean;
}): AvailabilityStatus {
  if (soldOut) return "sold_out";
  if (openForSale === true && hasBookingUrl) return "available";
  return "unknown";
}
