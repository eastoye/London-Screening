import type { ScreeningRecord } from "../_shared/importSafety.ts";
import {
  artworkUrl,
  bookingUrl,
  eventUrl,
  fetchRegentProgramme,
} from "./import-common.ts";
import {
  accessibility,
  availabilityStatus,
  countries,
  directors,
  explicitLabels,
  filmTitleHint,
  isSoldOut,
  legacyFormat,
  programmeTypes,
  projectionFormats,
  releaseYear,
  runtimeMinutes,
  screeningTags,
} from "./metadata.ts";

export const CINEMA_NAME = "Regent Street Cinema";
export const MIN_SCREENINGS = 2;

export async function parseRegentScreenings(now: Date): Promise<ScreeningRecord[]> {
  const programme = await fetchRegentProgramme();
  const records: ScreeningRecord[] = [];

  for (const { movie, showing } of programme) {
    if (!showing.published || showing.private) continue;
    if (!/^\d+$/.test(showing.id)) throw new Error(`Invalid Regent showing ID: ${showing.id}`);
    const parsedTime = new Date(showing.time);
    if (Number.isNaN(parsedTime.getTime())) throw new Error(`Invalid Regent time for showing ${showing.id}`);
    if (parsedTime <= now) continue;

    const displayTitle = movie.name.replace(/\s+/g, " ").trim();
    if (!displayTitle) throw new Error(`Missing Regent title for showing ${showing.id}`);
    const labels = explicitLabels(movie, showing);
    const titleHint = filmTitleHint(movie);
    const soldOut = isSoldOut(showing);

    records.push({
      cinema_name: CINEMA_NAME,
      movie_title: displayTitle,
      start_time: parsedTime.toISOString(),
      booking_url: soldOut ? null : bookingUrl(movie, showing),
      format: legacyFormat([displayTitle, ...labels]),
      sold_out: soldOut,
      projection_formats: projectionFormats([displayTitle, ...labels]),
      accessibility_features: accessibility(labels),
      programme_types: programmeTypes(labels),
      availability_status: availabilityStatus(showing),
      film_title_hint: titleHint,
      source_release_year: titleHint ? releaseYear(movie) : null,
      source_runtime_minutes: titleHint ? runtimeMinutes(movie) : null,
      source_directors: titleHint ? directors(movie) : [],
      source_countries: titleHint ? countries(movie) : [],
      source_event_url: eventUrl(movie),
      screen_name: showing.screen?.name?.trim() || null,
      screening_label: labels.join("; ") || null,
      screening_tags: screeningTags([displayTitle, ...labels]),
      verified_artwork_url: artworkUrl(movie),
      source_reference: `regent:${showing.id}`,
      last_seen_at: now.toISOString(),
    });
  }

  return records;
}
