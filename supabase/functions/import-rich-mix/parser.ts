import type { ScreeningRecord } from "../_shared/importSafety.ts";
import {
  CINEMA_NAME,
  eventIsFuture,
  fetchEvents,
  fetchInstancesForEvents,
  isCinemaEvent,
  officialPageConfirmsEmptyProgramme,
  publicBookingUrl,
  sourceArtworkUrl,
} from "./source.ts";
import {
  displayTitle,
  filmTitleHint,
  legacyFormat,
  runtimeMinutes,
  screenName,
  structuredMetadata,
} from "./metadata.ts";

export interface ParsedRichMixProgramme {
  records: ScreeningRecord[];
  eventsTotal: number;
  cinemaEventsTotal: number;
  futureCinemaEvents: number;
  instancesFetched: number;
  cancelledSkipped: number;
  pastSkipped: number;
  confirmedEmpty: boolean;
}

export async function parseRichMixProgramme(now: Date): Promise<ParsedRichMixProgramme> {
  const events = await fetchEvents();
  const cinemaEvents = events.filter(isCinemaEvent);
  const futureEvents = cinemaEvents.filter((event) => eventIsFuture(event, now));
  if (!futureEvents.length) {
    const confirmedEmpty = await officialPageConfirmsEmptyProgramme();
    if (!confirmedEmpty) throw new Error("Spektrix returned no future films and the official cinema page did not confirm an empty programme");
    return {
      records: [], eventsTotal: events.length, cinemaEventsTotal: cinemaEvents.length,
      futureCinemaEvents: 0, instancesFetched: 0, cancelledSkipped: 0, pastSkipped: 0,
      confirmedEmpty: true,
    };
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
    instancesFetched += instances.length;
    for (const instance of instances) {
      if (instance.cancelled) {
        cancelledSkipped++;
        continue;
      }
      const start = new Date(instance.startUtc);
      if (!Number.isFinite(start.getTime()) || !instance.id) {
        errors.push(`${event.name} has an incomplete instance (${instance.id || "no ID"})`);
        continue;
      }
      if (start <= now) {
        pastSkipped++;
        continue;
      }
      const booking = publicBookingUrl(instance.id);
      if (!booking) {
        errors.push(`${event.name} has no usable booking ID`);
        continue;
      }
      const reference = `richmix:spektrix:${instance.id}`;
      const title = displayTitle(event);
      const hint = filmTitleHint(event);
      const metadata = structuredMetadata(event, instance, booking);
      const record: ScreeningRecord = {
        cinema_name: CINEMA_NAME,
        movie_title: title,
        start_time: start.toISOString(),
        booking_url: booking,
        format: legacyFormat(event),
        sold_out: metadata.soldOut,
        projection_formats: metadata.projectionFormats,
        accessibility_features: metadata.accessibility,
        programme_types: metadata.programmes,
        availability_status: metadata.availability,
        film_title_hint: hint,
        source_release_year: null,
        source_runtime_minutes: hint ? runtimeMinutes(event) : null,
        source_directors: [],
        source_countries: [],
        source_event_url: null,
        screen_name: screenName(event),
        screening_label: metadata.labels.join("; ") || null,
        screening_tags: metadata.screeningTags,
        verified_artwork_url: sourceArtworkUrl(event),
        source_reference: reference,
        last_seen_at: now.toISOString(),
      };
      const existing = records.get(reference);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) errors.push(`conflicting duplicate ${reference}`);
      else records.set(reference, record);
    }
  }
  if (errors.length) throw new Error(`Rich Mix source was incomplete: ${errors.slice(0, 5).join("; ")}`);
  return {
    records: [...records.values()].sort((a, b) => a.start_time.localeCompare(b.start_time)),
    eventsTotal: events.length,
    cinemaEventsTotal: cinemaEvents.length,
    futureCinemaEvents: futureEvents.length,
    instancesFetched,
    cancelledSkipped,
    pastSkipped,
    confirmedEmpty: false,
  };
}
