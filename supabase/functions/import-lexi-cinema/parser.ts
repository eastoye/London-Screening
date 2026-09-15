import type { ScreeningRecord } from "../_shared/importSafety.ts";
import {
  CINEMA_NAME,
  artworkUrl,
  bookingUrl,
  fetchProgramme,
  officialUrl,
  startTime,
} from "./import-common.ts";
import {
  bookingUrlForAvailability,
  countries,
  directors,
  displayTitle,
  filmTitleHint,
  legacyFormat,
  releaseYear,
  runtimeMinutes,
  screeningTags,
  structuredMetadata,
} from "./metadata.ts";

export const MIN_SCREENINGS = 20;

export interface ParsedProgramme {
  records: ScreeningRecord[];
  sourceEvents: number;
  sourcePerformances: number;
  excludedNonFilms: number;
  skippedPast: number;
}

export async function parseLexiScreenings(now: Date): Promise<ParsedProgramme> {
  const events = await fetchProgramme();
  const records = new Map<string, ScreeningRecord>();
  const errors: string[] = [];
  let sourcePerformances = 0;
  let excludedNonFilms = 0;
  let skippedPast = 0;

  for (const event of events) {
    const performances = event.Performances ?? [];
    sourcePerformances += performances.length;
    if (event.TypeDescription !== "Film") {
      excludedNonFilms += performances.length;
      continue;
    }
    const title = displayTitle(event);
    if (!title) {
      if (performances.length) errors.push(`event ${event.ID ?? "unknown"} has no title`);
      continue;
    }
    for (const performance of performances) {
      const identifier = String(performance.ID ?? "").trim();
      const time = startTime(performance);
      const soldOut = performance.IsSoldOut === "Y";
      const sourceBooking = bookingUrl(performance.URL);
      if (!identifier || !time || (!sourceBooking && !soldOut)) {
        errors.push(`${title} has an incomplete performance (${identifier || "no ID"})`);
        continue;
      }
      if (new Date(time) <= now) {
        skippedPast++;
        continue;
      }
      const reference = `lexi:${identifier}`;
      const booking = bookingUrlForAvailability(sourceBooking, soldOut);
      const metadata = structuredMetadata(event, performance, booking);
      const hint = filmTitleHint(event, performance);
      const record: ScreeningRecord = {
        cinema_name: CINEMA_NAME,
        movie_title: title,
        start_time: time,
        booking_url: booking,
        format: legacyFormat(event),
        sold_out: soldOut,
        projection_formats: metadata.projectionFormats,
        accessibility_features: metadata.accessibilityFeatures,
        programme_types: metadata.programmeTypeValues,
        availability_status: metadata.availabilityStatus,
        film_title_hint: hint,
        source_release_year: hint ? releaseYear(event) : null,
        source_runtime_minutes: hint ? runtimeMinutes(event) : null,
        source_directors: hint ? directors(event) : [],
        source_countries: hint ? countries(event) : [],
        source_event_url: officialUrl(event.URL),
        screen_name: performance.AuditoriumName?.replace(/\s+/g, " ").trim() || null,
        screening_label: metadata.labels.join("; ") || null,
        screening_tags: screeningTags(title, metadata.labels, performance),
        verified_artwork_url: artworkUrl(event.ImageURL),
        source_reference: reference,
        last_seen_at: now.toISOString(),
      };
      const existing = records.get(reference);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) errors.push(`conflicting duplicate ${reference}`);
      else records.set(reference, record);
    }
  }
  if (errors.length) throw new Error(`Lexi programme parsing incomplete: ${errors.slice(0, 5).join("; ")}`);
  return {
    records: [...records.values()].sort((a, b) => a.start_time.localeCompare(b.start_time)),
    sourceEvents: events.length,
    sourcePerformances,
    excludedNonFilms,
    skippedPast,
  };
}
