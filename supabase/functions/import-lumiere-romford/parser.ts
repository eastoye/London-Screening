import type { ScreeningRecord } from "../_shared/importSafety.ts";
import {
  CINEMA_NAME,
  artworkUrl,
  bookingUrl,
  eventUrl,
  fetchProgramme,
  startTime,
} from "./import-common.ts";
import {
  accessibility,
  availability,
  countries,
  directors,
  exclusionReason,
  explicitLabels,
  filmTitleHint,
  legacyFormat,
  programmeTypes,
  projectionFormats,
  releaseYear,
  runtimeMinutes,
  screeningTags,
} from "./metadata.ts";

export const MIN_SCREENINGS = 8;

export interface ParsedProgramme {
  dates: string[];
  records: ScreeningRecord[];
  excludedByReason: Record<string, number>;
}

export async function parseLumiereScreenings(now: Date): Promise<ParsedProgramme> {
  const programme = await fetchProgramme();
  const records = new Map<string, ScreeningRecord>();
  const excludedByReason: Record<string, number> = {};
  const parseErrors: string[] = [];

  for (const movie of programme.movies) {
    const displayTitle = movie.movie_name?.replace(/\s+/g, " ").trim();
    if (!displayTitle) {
      if ((movie.show_times ?? []).length) parseErrors.push(`movie ${movie.movie_id ?? "unknown"} has no title`);
      continue;
    }
    for (const show of movie.show_times ?? []) {
      const excluded = exclusionReason(movie, show);
      if (excluded) {
        excludedByReason[excluded] = (excludedByReason[excluded] ?? 0) + 1;
        continue;
      }
      const identifier = String(show.show_time_uuid ?? show.show_time_id ?? "").trim();
      const time = startTime(show);
      if (!identifier || !time) {
        parseErrors.push(`${displayTitle} has a showing without a stable ID or time`);
        continue;
      }
      if (new Date(time) <= now) continue;
      const reference = `lumiere-romford:showtime:${identifier}`;
      const booking = bookingUrl(movie, show);
      const labels = explicitLabels(movie, show);
      const filmHint = filmTitleHint(movie);
      const state = availability(movie, show, Boolean(booking));
      const record: ScreeningRecord = {
        cinema_name: CINEMA_NAME,
        movie_title: displayTitle,
        start_time: time,
        booking_url: state.soldOut ? null : booking,
        format: legacyFormat(labels),
        sold_out: state.soldOut,
        projection_formats: projectionFormats(labels),
        accessibility_features: accessibility(labels),
        programme_types: programmeTypes(show, labels),
        availability_status: state.status,
        film_title_hint: filmHint,
        source_release_year: filmHint ? releaseYear(movie) : null,
        source_runtime_minutes: filmHint ? runtimeMinutes(movie) : null,
        source_directors: filmHint ? directors(movie) : [],
        source_countries: filmHint ? countries(movie) : [],
        source_event_url: eventUrl(movie),
        screen_name: show.screen_name?.replace(/\s+/g, " ").trim() || null,
        screening_label: labels.join("; ") || null,
        screening_tags: screeningTags([displayTitle, ...labels]),
        verified_artwork_url: artworkUrl(movie),
        source_reference: reference,
        last_seen_at: now.toISOString(),
      };
      const existing = records.get(reference);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        parseErrors.push(`conflicting duplicate ${reference}`);
      } else {
        records.set(reference, record);
      }
    }
  }
  if (parseErrors.length) throw new Error(`Lumiere programme parsing incomplete: ${parseErrors.slice(0, 5).join("; ")}`);
  return {
    dates: programme.dates,
    records: [...records.values()].sort((a, b) => a.start_time.localeCompare(b.start_time)),
    excludedByReason,
  };
}
