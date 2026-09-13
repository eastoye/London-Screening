// ICA Cinema V2 importer.
// Eligibility and public titles: https://www.ica.art/films and its detail pages.
// Performance cross-check and metadata: ICA's public Spektrix v3 API.
// Legacy source_reference remains ica:{numericEventId}:{startUtc}:{screenName}.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  commitImport,
  corsHeaders,
  endRun,
  jsonResponse,
  startRun,
  type ImportRunContext,
  type ScreeningRecord,
} from "../_shared/importSafety.ts";
import { availabilityFromSignals, compactStrings } from "../_shared/screeningMetadata.ts";
import {
  fetchEvents,
  fetchInstances,
  parseStartTime,
  type SpektrixConfig,
  type SpektrixEvent,
  type SpektrixInstance,
} from "../_shared/spektrixParser.ts";
import {
  discoverFilmPaths,
  fetchText,
  parseFilmPage,
  performanceKey,
  type IcaFilmPage,
} from "./import-common.ts";
import {
  explicitPerformanceLabels,
  icaAccessibility,
  icaProgrammeTypes,
  icaProjectionFormats,
  icaScreeningTags,
  legacyFormat,
  parseIcaMetadata,
} from "./metadata.ts";

const CINEMA_NAME = "ICA Cinema";
const BASE_URL = "https://www.ica.art";
const LIST_URL = `${BASE_URL}/films`;
const MIN_SCREENINGS = 3;
const MIN_EXPECTED_RATIO = 0.5;
const RATIO_GUARD_MIN_EXISTING = 10;
const PAGE_BATCH_SIZE = 6;
const INSTANCE_BATCH_SIZE = 5;

const spektrix: SpektrixConfig = {
  client: "ica",
  baseUrl: "https://system.spektrix.com",
  sourcePrefix: "ica",
};

function numericEventId(eventId: string): string {
  return eventId.match(/^\d+/)?.[0] ?? "";
}

function isFilmEvent(event: SpektrixEvent): boolean {
  return String(event.attributes.attribute_Category ?? "").trim().toLowerCase() === "films";
}

function instanceLabels(instance: SpektrixInstance): string[] {
  const labels: string[] = [];
  if (instance.attributes.attribute_Captioned === true) labels.push("Captioned");
  if (instance.attributes.attribute_BSLInterpreted === true) labels.push("BSL interpreted");
  const additional = String(instance.attributes.attribute_AdditionalInformation ?? "").trim();
  if (additional) labels.push(additional);
  return compactStrings(labels);
}

function explicitlySoldOut(labels: ReadonlyArray<string>): boolean {
  return labels.some((label) => /^sold\s*out$/i.test(label.trim()));
}

async function fetchFilmPages(paths: string[]): Promise<IcaFilmPage[]> {
  const pages: IcaFilmPage[] = [];
  for (let index = 0; index < paths.length; index += PAGE_BATCH_SIZE) {
    const batch = paths.slice(index, index + PAGE_BATCH_SIZE);
    const results = await Promise.all(batch.map(async (path) => {
      const html = await fetchText(`${BASE_URL}${path}`, `ICA page ${path}`);
      return parseFilmPage(BASE_URL, path, html);
    }));
    pages.push(...results.filter((page): page is IcaFilmPage => page !== null));
  }
  return pages;
}

async function fetchPageInstances(
  pages: IcaFilmPage[],
  eventsByNumericId: Map<string, SpektrixEvent>
): Promise<Map<string, SpektrixInstance[]>> {
  const result = new Map<string, SpektrixInstance[]>();
  for (let index = 0; index < pages.length; index += INSTANCE_BATCH_SIZE) {
    const batch = pages.slice(index, index + INSTANCE_BATCH_SIZE);
    const fetched = await Promise.all(batch.map(async (page) => {
      const event = eventsByNumericId.get(page.bookingEventId);
      if (!event) throw new Error(`No film-classified Spektrix event matched ICA event ${page.bookingEventId}`);
      return { page, instances: await fetchInstances(spektrix, event.id) };
    }));
    for (const item of fetched) result.set(item.page.bookingEventId, item.instances);
  }
  return result;
}

async function previousActiveCount(ctx: ImportRunContext, nowUtc: Date): Promise<number> {
  const { count, error } = await ctx.supabase
    .from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME)
    .eq("active", true)
    .gt("start_time", nowUtc.toISOString());
  if (error) throw new Error(`Could not read previous screening count: ${error.message}`);
  return count ?? 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const startedAt = new Date();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ success: false, error: "Missing Supabase credentials." }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ctx: ImportRunContext = {
    supabase,
    cinemaName: CINEMA_NAME,
    minScreenings: MIN_SCREENINGS,
    startedAt,
  };
  const runStart = await startRun(ctx);
  if (runStart.blocked) {
    return jsonResponse({ success: false, blocked: true, error: "Import already running." }, 409);
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  try {
    const nowUtc = new Date();
    const [listHtml, allEvents] = await Promise.all([
      fetchText(LIST_URL, "ICA film programme"),
      fetchEvents(spektrix),
    ]);
    const paths = discoverFilmPaths(listHtml);
    if (paths.length < 5) throw new Error(`ICA film discovery returned only ${paths.length} paths`);

    const filmEvents = allEvents.filter(isFilmEvent);
    const eventsByNumericId = new Map<string, SpektrixEvent>();
    for (const event of filmEvents) {
      const id = numericEventId(event.id);
      if (!id) continue;
      if (eventsByNumericId.has(id)) throw new Error(`Duplicate Spektrix numeric event id ${id}`);
      eventsByNumericId.set(id, event);
    }

    const pages = await fetchFilmPages(paths);
    if (pages.length < 3) throw new Error(`ICA pages exposed only ${pages.length} bookable film events`);
    const instancesByEvent = await fetchPageInstances(pages, eventsByNumericId);
    const records: ScreeningRecord[] = [];

    for (const page of pages) {
      const metadata = parseIcaMetadata(page.displayTitle, page.html);
      const pageFuture = page.performances.filter((performance) => new Date(performance.startTime) > nowUtc);
      const instances = (instancesByEvent.get(page.bookingEventId) ?? []).filter((instance) => {
        const start = parseStartTime(instance);
        return !instance.cancelled && Boolean(start) && new Date(start as string) > nowUtc;
      });

      const pageKeys = new Set(pageFuture.map((performance) => performanceKey(performance.startTime, performance.screenName)));
      const instanceKeys = new Set(instances.map((instance) => {
        const start = parseStartTime(instance) as string;
        const screen = String(instance.attributes.attribute_Venue ?? "").trim();
        return performanceKey(start, screen);
      }));
      if (pageKeys.size !== instanceKeys.size || [...pageKeys].some((key) => !instanceKeys.has(key))) {
        throw new Error(`ICA page/API performance mismatch for ${page.path}`);
      }

      for (const instance of instances) {
        const startTime = parseStartTime(instance);
        const screenName = String(instance.attributes.attribute_Venue ?? "").trim();
        if (!startTime || !screenName) throw new Error(`Incomplete Spektrix instance for ${page.path}`);
        const rawInstanceLabels = instanceLabels(instance);
        const labels = explicitPerformanceLabels({
          displayTitle: page.displayTitle,
          metadata,
          startTime,
          performanceCount: instances.length,
          instanceLabels: rawInstanceLabels,
        });
        const soldOut = explicitlySoldOut(rawInstanceLabels);
        const bookingUrl = `${BASE_URL}/book/${page.bookingEventId}`;
        const projectionFormats = icaProjectionFormats(labels);

        records.push({
          cinema_name: CINEMA_NAME,
          movie_title: page.displayTitle,
          start_time: startTime,
          booking_url: soldOut ? null : bookingUrl,
          format: legacyFormat(labels),
          sold_out: soldOut,
          projection_formats: projectionFormats,
          accessibility_features: icaAccessibility(labels),
          programme_types: icaProgrammeTypes(labels),
          availability_status: availabilityFromSignals({
            soldOut,
            openForSale: instance.isOnSale,
            hasBookingUrl: true,
          }),
          film_title_hint: metadata.filmTitleHint,
          source_release_year: metadata.releaseYear,
          source_runtime_minutes: metadata.runtimeMinutes,
          source_directors: metadata.directors,
          source_countries: metadata.countries,
          source_event_url: page.url,
          screen_name: screenName,
          screening_label: labels.filter((label) => !/^English subtitles$/i.test(label)).join(" · ") || null,
          screening_tags: icaScreeningTags(labels),
          verified_artwork_url: metadata.artworkUrl,
          source_reference: `ica:${page.bookingEventId}:${startTime}:${screenName}`,
          last_seen_at: nowUtc.toISOString(),
        });
      }
    }

    const uniqueReferences = new Set(records.map((record) => record.source_reference));
    if (uniqueReferences.size !== records.length) throw new Error("Duplicate source references returned");
    if (records.length < MIN_SCREENINGS) throw new Error(`Unusually low screening count (${records.length})`);
    const previous = await previousActiveCount(ctx, nowUtc);
    if (previous >= RATIO_GUARD_MIN_EXISTING && records.length < Math.ceil(previous * MIN_EXPECTED_RATIO)) {
      throw new Error(`Suspicious count drop from ${previous} to ${records.length}`);
    }

    const committed = await commitImport(ctx, records, nowUtc);
    if (committed.errors.length) throw new Error(committed.errors.join("; "));
    await endRun(ctx, runId, "success", records.length, committed.saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      film_paths: paths.length,
      bookable_events: pages.length,
      screenings_found: records.length,
      screenings_saved: committed.saved,
      previous_active: previous,
      metadata: {
        title_hints: records.filter((record) => record.film_title_hint).length,
        years: records.filter((record) => record.source_release_year).length,
        runtime: records.filter((record) => record.source_runtime_minutes).length,
        artwork: records.filter((record) => record.verified_artwork_url).length,
        known_availability: records.filter((record) => record.availability_status !== "unknown").length,
      },
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
