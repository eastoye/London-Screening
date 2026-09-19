import type { ScreeningRecord } from "../_shared/importSafety.ts";
import {
  CINEMA_NAME,
  bookingUrl,
  eventIsFuture,
  fetchEvents,
  fetchInstancesForEvents,
  isCinemaEvent,
  parseInstanceStart,
  sourceArtworkUrl,
} from "./source.ts";
import {
  displayTitle,
  filmTitleHint,
  legacyFormat,
  sourceReleaseYear,
  sourceRuntimeMinutes,
  structuredMetadata,
} from "./metadata.ts";

export interface ParsedKilnProgramme {
  records: ScreeningRecord[];
  eventsTotal: number;
  cinemaEventsTotal: number;
  futureCinemaEvents: number;
  instancesFetched: number;
  cancelledSkipped: number;
  pastSkipped: number;
}

export async function parseKilnProgramme(now: Date): Promise<ParsedKilnProgramme> {
  const events = await fetchEvents();
  const cinemaEvents = events.filter(isCinemaEvent);
  const futureEvents = cinemaEvents.filter((event) => eventIsFuture(event, now));
  if (!futureEvents.length) {
    throw new Error("Spektrix returned no future Kiln cinema events; database left untouched");
  }

  const instanceMap = await fetchInstancesForEvents(futureEvents);
  const records = new Map<string, ScreeningRecord>();
  const errors: string[] = [];
  let instancesFetched = 0;
  let cancelledSkipped = 0;
  let pastSkipped = 0;

  for (const event of futureEvents) {
    const instances = instanceMap.get(event.id);
    if (!instances) {
      errors.push(`${event.name} returned no instance response`);
      continue;
    }
    if (!instances.length) {
      errors.push(`${event.name} is future-dated but returned zero instances`);
      continue;
    }
    instancesFetched += instances.length;

    for (const instance of instances) {
      if (instance.cancelled) {
        cancelledSkipped++;
        continue;
      }
      const start = parseInstanceStart(instance);
      if (!start || !instance.id) {
        errors.push(`${event.name} has an incomplete instance (${instance.id || "no ID"})`);
        continue;
      }
      if (start <= now) {
        pastSkipped++;
        continue;
      }

      const booking = bookingUrl(instance.id);
      if (!booking) {
        errors.push(`${event.name} has no usable booking ID`);
        continue;
      }

      const reference = `kiln:spektrix:${instance.id}`;
      const metadata = structuredMetadata(event, instance, booking);
      const hint = filmTitleHint(event);
      const record: ScreeningRecord = {
        cinema_name: CINEMA_NAME,
        movie_title: displayTitle(event),
        start_time: start.toISOString(),
        booking_url: booking,
        format: legacyFormat(event),
        sold_out: metadata.soldOut,
        projection_formats: metadata.projectionFormats,
        accessibility_features: metadata.accessibility,
        programme_types: metadata.programmes,
        availability_status: metadata.availability,
        film_title_hint: hint,
        source_release_year: sourceReleaseYear(event),
        source_runtime_minutes: sourceRuntimeMinutes(event),
        source_directors: [],
        source_countries: [],
        source_event_url: null,
        screen_name: null,
        screening_label: metadata.labels.join("; ") || null,
        screening_tags: metadata.screeningTags,
        verified_artwork_url: sourceArtworkUrl(event),
        source_reference: reference,
        last_seen_at: now.toISOString(),
      };

      const existing = records.get(reference);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        errors.push(`conflicting duplicate ${reference}`);
      } else {
        records.set(reference, record);
      }
    }
  }

  if (errors.length) {
    throw new Error(`Kiln source was incomplete: ${errors.slice(0, 5).join("; ")}`);
  }

  return {
    records: [...records.values()].sort((a, b) => a.start_time.localeCompare(b.start_time)),
    eventsTotal: events.length,
    cinemaEventsTotal: cinemaEvents.length,
    futureCinemaEvents: futureEvents.length,
    instancesFetched,
    cancelledSkipped,
    pastSkipped,
  };
}
