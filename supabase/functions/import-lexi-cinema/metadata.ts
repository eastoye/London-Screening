import {
  availabilityFromSignals,
  normaliseProjectionFormats,
  type AccessibilityFeature,
  type AvailabilityStatus,
  type ProgrammeType,
  type ProjectionFormat,
} from "../_shared/screeningMetadata.ts";

interface LexiMetadataEvent {
  Tags: { Format: string }[];
}

interface LexiMetadataPerformance {
  BF: string;
  AD: string;
  HOH: string;
  RS: string;
  IsSoldOut: string;
  IsOpenForSale: boolean;
  Notes: string;
  URL: string;
}

export function buildStructuredMetadata(
  event: LexiMetadataEvent,
  performance: LexiMetadataPerformance
): {
  projection_formats: ProjectionFormat[];
  accessibility_features: AccessibilityFeature[];
  programme_types: ProgrammeType[];
  availability_status: AvailabilityStatus;
} {
  const accessibilityFeatures: AccessibilityFeature[] = [];
  if (performance.HOH === "Y") accessibilityFeatures.push("captioned");
  if (performance.AD === "Y") accessibilityFeatures.push("audio_described");
  if (performance.RS === "Y") accessibilityFeatures.push("relaxed");

  const programmeTypes: ProgrammeType[] = [];
  if (performance.BF === "Y") programmeTypes.push("parent_and_baby");
  if (/Lexi Seniors['’] Film Club/i.test(performance.Notes)) {
    programmeTypes.push("seniors");
  }

  return {
    projection_formats: normaliseProjectionFormats(
      event.Tags.map((tag) => tag.Format)
    ),
    accessibility_features: accessibilityFeatures,
    programme_types: programmeTypes,
    availability_status: availabilityFromSignals({
      soldOut: performance.IsSoldOut === "Y",
      openForSale: performance.IsOpenForSale,
      hasBookingUrl: Boolean(performance.URL),
    }),
  };
}
