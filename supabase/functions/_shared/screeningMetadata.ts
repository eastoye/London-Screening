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

export type ProjectionFormat = (typeof PROJECTION_FORMATS)[number];
export type AccessibilityFeature = (typeof ACCESSIBILITY_FEATURES)[number];
export type ProgrammeType = (typeof PROGRAMME_TYPES)[number];
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

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
