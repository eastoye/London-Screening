// JW3 Cinema V2 importer.
// Primary source: JW3's public Spektrix v3 API.
// Optional enrichment: JW3 sitemap and canonical public event pages.
// source_reference remains jw3:spektrix:{EventInstanceId}.

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
  fetchPlanMap,
  parseStartTime,
  type SpektrixConfig,
  type SpektrixEvent,
  type SpektrixInstance,
} from "../_shared/spektrixParser.ts";
import {
  eventPageForTitle,
  explicitTitleLabels,
  jw3Accessibility,
  jw3ProgrammeTypes,
  jw3ProjectionFormats,
  jw3ScreeningTags,
  mapJw3EventPages,
  parseJw3Page,
  safeFilmTitleHint,
  sourceYear,
  type Jw3PageMetadata,
} from "./metadata.ts";

const CINEMA_NAME = "JW3 Cinema";
const MIN_SCREENINGS = 3;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const EVENT_END_BUFFER_MS = 2 * 60 * 60 * 1000;
const FETCH_BATCH_SIZE = 5;
const PAGE_FETCH_BATCH_SIZE = 4;
const PAGE_TIMEOUT_MS = 12_000;
const SITEMAP_URL = "https://www.jw3.org.uk/sitemap.xml";

const config: SpektrixConfig = {
  client: "jw3",
  baseUrl: "https://system.spektrix.com",
  sourcePrefix: "jw3",
};

const sourceHeaders = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
};

function isCinemaEvent(event: SpektrixEvent): boolean {
  return String(event.attributes.attribute_Genre ?? "").trim().toLowerCase() === "cinema";
}

function mayHaveUpcomingInstances(event: SpektrixEvent, nowUtc: Date): boolean {
  const raw = String(event.lastInstanceDateTime ?? "").trim();
  if (!raw) return true;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const end = new Date(withZone);
  if (Number.isNaN(end.getTime())) return true;
  return end.getTime() >= nowUtc.getTime() - EVENT_END_BUFFER_MS;
}

async function fetchCandidateInstances(
  events: SpektrixEvent[]
): Promise<Array<{ event: SpektrixEvent; instance: SpektrixInstance }>> {
  const pairs: Array<{ event: SpektrixEvent; instance: SpektrixInstance }> = [];
  for (let i = 0; i < events.length; i += FETCH_BATCH_SIZE) {
    const batch = events.slice(i, i + FETCH_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (event) => ({ event, instances: await fetchInstances(config, event.id) }))
    );
    for (const result of results) {
      for (const instance of result.instances) pairs.push({ event: result.event, instance });
    }
  }
  return pairs;
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: sourceHeaders,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPageMetadata(
  events: SpektrixEvent[]
): Promise<{
  pages: Map<string, { url: string; metadata: Jw3PageMetadata | null }>;
  sitemapAvailable: boolean;
  detailPagesMatched: number;
  detailPagesFetched: number;
}> {
  const sitemap = await fetchText(SITEMAP_URL, PAGE_TIMEOUT_MS);
  if (!sitemap) {
    return { pages: new Map(), sitemapAvailable: false, detailPagesMatched: 0, detailPagesFetched: 0 };
  }

  const pageIndex = mapJw3EventPages(sitemap);
  const pages = new Map<string, { url: string; metadata: Jw3PageMetadata | null }>();
  const matched = events.flatMap((event) => {
    const url = eventPageForTitle(event.name, pageIndex);
    return url ? [{ event, url }] : [];
  });

  let detailPagesFetched = 0;
  for (let i = 0; i < matched.length; i += PAGE_FETCH_BATCH_SIZE) {
    const batch = matched.slice(i, i + PAGE_FETCH_BATCH_SIZE);
    const results = await Promise.all(batch.map(async ({ event, url }) => {
      const html = await fetchText(url, PAGE_TIMEOUT_MS);
      return { event, url, metadata: html ? parseJw3Page(html) : null };
    }));
    for (const result of results) {
      if (result.metadata) detailPagesFetched += 1;
      pages.set(result.event.id, { url: result.url, metadata: result.metadata });
    }
  }

  return {
    pages,
    sitemapAvailable: true,
    detailPagesMatched: matched.length,
    detailPagesFetched,
  };
}

function explicitInstanceLabels(instance: SpektrixInstance): string[] {
  const labels: string[] = [];
  if (instance.attributes.attribute_SLCaptioned === true) labels.push("Captioned");
  const freeText = String(instance.attributes.attribute_SLFreeText ?? "").trim();
  if (freeText) labels.push(freeText);
  return compactStrings(labels);
}

function pageSaysSoldOut(status: unknown): boolean {
  return /^sold\s*out$/i.test(String(status ?? "").trim());
}

function pageSaysAvailable(status: unknown): boolean {
  return /^normal$/i.test(String(status ?? "").trim());
}

async function getPreviousActiveCount(ctx: ImportRunContext, nowUtc: Date): Promise<number> {
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
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

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
    const allEvents = await fetchEvents(config);
    const cinemaEvents = allEvents.filter(isCinemaEvent);
    const candidates = cinemaEvents.filter((event) => mayHaveUpcomingInstances(event, nowUtc));
    if (candidates.length === 0) {
      throw new Error("Spektrix returned no upcoming cinema events; database left untouched.");
    }

    const [pairs, planMap, enrichment] = await Promise.all([
      fetchCandidateInstances(candidates),
      fetchPlanMap(config),
      fetchPageMetadata(candidates),
    ]);
    const records: ScreeningRecord[] = [];
    const parseErrors: string[] = [];

    for (const { event, instance } of pairs) {
      if (instance.cancelled) continue;
      const startTime = parseStartTime(instance);
      if (!instance.id || !startTime) {
        parseErrors.push(`Invalid instance for event ${event.id}`);
        continue;
      }
      if (new Date(startTime).getTime() <= nowUtc.getTime()) continue;

      const page = enrichment.pages.get(event.id) ?? null;
      const pageMetadata = page?.metadata ?? null;
      const pageItem = pageMetadata?.itemByInstanceId.get(instance.id);
      const titleLabels = explicitTitleLabels(event.name);
      const instanceLabels = explicitInstanceLabels(instance);
      const series = String(event.attributes.attribute_SeriesOrFestival ?? "").trim();
      const structuredLabels = compactStrings([...titleLabels, ...instanceLabels]);
      const displayLabels = compactStrings([...structuredLabels, series || null]);
      const projectionFormats = jw3ProjectionFormats(structuredLabels);
      const soldOut = pageSaysSoldOut(pageItem?.item_status);
      const bookingUrl = `https://www.jw3.org.uk/spektrix/ChooseSeats?EventInstanceId=${encodeURIComponent(instance.id)}`;
      const planName = planMap.get(instance.planId)?.name?.trim() || null;

      records.push({
        cinema_name: CINEMA_NAME,
        movie_title: event.name.trim(),
        start_time: startTime,
        booking_url: soldOut ? null : bookingUrl,
        format: projectionFormats.length > 0 ? projectionFormats.join(", ") : null,
        sold_out: soldOut,
        projection_formats: projectionFormats,
        accessibility_features: jw3Accessibility(structuredLabels),
        programme_types: jw3ProgrammeTypes(event.name),
        availability_status: availabilityFromSignals({
          soldOut,
          // JW3 can leave Spektrix isOnSale=true on a publicly sold-out page.
          // Only the public page's exact normal status confirms availability.
          openForSale: pageSaysAvailable(pageItem?.item_status) && instance.isOnSale === true
            ? true
            : null,
          hasBookingUrl: true,
        }),
        film_title_hint: safeFilmTitleHint(event.name),
        source_release_year: sourceYear(event.name, pageMetadata),
        source_runtime_minutes: pageMetadata?.runtimeMinutes ??
          (Number.isInteger(event.duration) && event.duration > 0 ? event.duration : null),
        source_directors: pageMetadata?.directors ?? [],
        source_countries: pageMetadata?.countries ?? [],
        source_event_url: pageMetadata?.canonicalUrl ?? page?.url ?? null,
        screen_name: String(pageItem?.item_hall ?? "").trim() || planName,
        screening_label: displayLabels.length > 0 ? displayLabels.join(" · ") : null,
        screening_tags: jw3ScreeningTags(structuredLabels),
        verified_artwork_url: pageMetadata?.artworkUrl ?? null,
        source_reference: `jw3:spektrix:${instance.id}`,
        last_seen_at: nowUtc.toISOString(),
      });
    }

    if (parseErrors.length > 0) {
      throw new Error(`Spektrix parse was incomplete: ${parseErrors.slice(0, 5).join("; ")}`);
    }
    const sourceRefs = new Set(records.map((record) => record.source_reference));
    if (sourceRefs.size !== records.length) {
      throw new Error("Duplicate performance IDs were returned; database left untouched.");
    }
    if (records.length < MIN_SCREENINGS) {
      throw new Error(`Unusually low screening count (${records.length}); database left untouched.`);
    }

    const previousActive = await getPreviousActiveCount(ctx, nowUtc);
    const ratioFloor = Math.ceil(previousActive * MIN_EXPECTED_RATIO);
    if (previousActive >= RATIO_GUARD_MIN_EXISTING && records.length < ratioFloor) {
      throw new Error(
        `Suspicious count drop from ${previousActive} to ${records.length}; database left untouched.`
      );
    }

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length > 0) throw new Error(`Import errors: ${errors.join("; ")}`);

    await endRun(ctx, runId, "success", records.length, saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: records.length,
      screenings_saved: saved,
      events_total: allEvents.length,
      cinema_events_total: cinemaEvents.length,
      cinema_events_checked: candidates.length,
      instances_fetched: pairs.length,
      previous_active: previousActive,
      sitemap_available: enrichment.sitemapAvailable,
      detail_pages_matched: enrichment.detailPagesMatched,
      detail_pages_fetched: enrichment.detailPagesFetched,
      metadata_population: {
        title_hints: records.filter((r) => r.film_title_hint).length,
        years: records.filter((r) => r.source_release_year).length,
        runtimes: records.filter((r) => r.source_runtime_minutes).length,
        directors: records.filter((r) => (r.source_directors?.length ?? 0) > 0).length,
        artwork: records.filter((r) => r.verified_artwork_url).length,
        event_urls: records.filter((r) => r.source_event_url).length,
        availability_known: records.filter((r) => r.availability_status !== "unknown").length,
        screens: records.filter((r) => r.screen_name).length,
      },
      import_started_at: startedAt.toISOString(),
      import_completed_at: new Date().toISOString(),
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
