import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonOffsetMinutes,
  londonToUtc,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import { extractDetailEnrichment, extractProgramme, normaliseTitle, type ParsedPerformance } from "./parser.ts";

const HOMEPAGE_URL = "https://www.davidleancinema.uk/";
const CINEMA_NAME = "David Lean Cinema";
const SOURCE_PREFIX = "davidlean";
const MIN_SCREENINGS = 5;
const MIN_PROGRAMME_CARDS = 8;
const MAX_COUNT_DROP_RATIO = 0.5;

const fetchOptions: RequestInit = {
  headers: {
    "User-Agent": "LondonScreenings/2.0 (+https://github.com/eastoye/London-Screening)",
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  redirect: "follow",
};

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    ...fetchOptions,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const html = await response.text();
  if (html.length < 1_000) throw new Error(`${url} returned an unexpectedly small page`);
  return html;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function enrichDetailPages(performances: ParsedPerformance[]): Promise<string[]> {
  const detailUrls = Array.from(new Set(
    performances.map((item) => item.sourceEventUrl).filter((url) => url !== HOMEPAGE_URL)
  ));
  const warnings: string[] = [];
  await mapWithConcurrency(detailUrls, 3, async (url) => {
    try {
      const detail = extractDetailEnrichment(await fetchHtml(url));
      for (const item of performances.filter((candidate) => candidate.sourceEventUrl === url)) {
        if (detail.directors.length) item.directors = detail.directors;
        if (detail.bookingUrl) item.bookingUrl = detail.bookingUrl;
      }
    } catch (error) {
      warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return warnings;
}

async function resolveBookingUrls(performances: ParsedPerformance[]): Promise<string[]> {
  const urls = Array.from(new Set(performances.map((item) => item.bookingUrl).filter(Boolean) as string[]));
  const resolved = new Map<string, string>();
  const warnings: string[] = [];
  await mapWithConcurrency(urls, 6, async (url) => {
    if (!/^https:\/\/tinyurl\.com\//i.test(url)) return;
    try {
      const response = await fetch(url, { ...fetchOptions, method: "HEAD" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (/^https:\/\//i.test(response.url)) resolved.set(url, response.url);
    } catch (error) {
      warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  for (const item of performances) {
    if (item.bookingUrl && resolved.has(item.bookingUrl)) item.bookingUrl = resolved.get(item.bookingUrl)!;
  }
  return warnings;
}

function validateUnique(records: ScreeningRecord[]): string | null {
  const references = new Set<string>();
  const titleTimes = new Set<string>();
  for (const record of records) {
    if (references.has(record.source_reference)) return `Duplicate source reference: ${record.source_reference}`;
    references.add(record.source_reference);
    const titleTime = `${record.movie_title.toLowerCase()}|${record.start_time}`;
    if (titleTimes.has(titleTime)) return `Duplicate title/time: ${record.movie_title} at ${record.start_time}`;
    titleTimes.add(titleTime);
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  const startedAt = new Date();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ success: false, error: "Missing Supabase credentials." }, 500);

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ctx: ImportRunContext = { supabase, cinemaName: CINEMA_NAME, minScreenings: MIN_SCREENINGS, startedAt };
  const runStart = await startRun(ctx);
  if (runStart.blocked) return jsonResponse({ success: false, blocked: true, error: "Another import is already running." }, 409);
  if (runStart.error || !runStart.runId) return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  const runId = runStart.runId;

  try {
    const html = await fetchHtml(HOMEPAGE_URL);
    const nowUtc = new Date();
    const nowLondon = new Date(nowUtc.getTime() + londonOffsetMinutes(nowUtc) * 60_000);
    const parsed = extractProgramme(html, nowLondon);

    if (parsed.cardCount < MIN_PROGRAMME_CARDS) {
      throw new Error(`Only ${parsed.cardCount} programme cards found; source may be incomplete.`);
    }
    if (parsed.errors.length) {
      throw new Error(`Programme parsing was incomplete: ${parsed.errors.slice(0, 5).join("; ")}`);
    }

    const detailWarnings = await enrichDetailPages(parsed.performances);
    const bookingWarnings = await resolveBookingUrls(parsed.performances);
    const upcoming = parsed.performances.filter((item) => {
      const start = londonToUtc(item.year, item.month, item.day, item.hour, item.minute);
      return start.getTime() > nowUtc.getTime();
    });

    const records: ScreeningRecord[] = upcoming.map((item) => {
      const start = londonToUtc(item.year, item.month, item.day, item.hour, item.minute);
      const date = `${item.year}-${String(item.month).padStart(2, "0")}-${String(item.day).padStart(2, "0")}`;
      const time = `${String(item.hour).padStart(2, "0")}${String(item.minute).padStart(2, "0")}`;
      const referenceTitle = item.filmTitleHint ?? item.movieTitle;
      return {
        cinema_name: CINEMA_NAME,
        movie_title: item.movieTitle,
        film_title_hint: item.filmTitleHint,
        start_time: start.toISOString(),
        booking_url: item.bookingUrl,
        format: item.projectionFormats.length ? item.projectionFormats.join(", ") : null,
        sold_out: item.soldOut,
        projection_formats: item.projectionFormats,
        accessibility_features: item.accessibilityFeatures,
        programme_types: item.programmeTypes,
        availability_status: item.soldOut ? "sold_out" : item.bookingUrl ? "available" : "unknown",
        source_release_year: item.releaseYear,
        source_runtime_minutes: item.runtimeMinutes,
        source_directors: item.directors,
        source_countries: item.countries,
        source_event_url: item.sourceEventUrl,
        screen_name: null,
        screening_label: item.screeningLabel,
        screening_tags: item.screeningTags,
        verified_artwork_url: item.artworkUrl,
        source_reference: `${SOURCE_PREFIX}:${normaliseTitle(referenceTitle)}:${date}:${time}`,
        last_seen_at: startedAt.toISOString(),
      };
    });

    if (records.length < MIN_SCREENINGS) throw new Error(`Only ${records.length} future screenings parsed; database left untouched.`);
    const duplicateError = validateUnique(records);
    if (duplicateError) throw new Error(duplicateError);

    const { count: existingCount, error: countError } = await supabase
      .from("screenings")
      .select("id", { count: "exact", head: true })
      .eq("cinema_name", CINEMA_NAME)
      .eq("active", true)
      .gt("start_time", nowUtc.toISOString());
    if (countError) throw new Error(`Could not check current coverage: ${countError.message}`);
    if ((existingCount ?? 0) >= 10 && records.length < Math.ceil((existingCount ?? 0) * MAX_COUNT_DROP_RATIO)) {
      throw new Error(`Count-drop safeguard: parsed ${records.length} versus ${existingCount} existing future screenings.`);
    }

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length) throw new Error(`Import errors: ${errors.join("; ")}`);
    await endRun(ctx, runId, "success", parsed.performances.length, saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      programme_cards: parsed.cardCount,
      screenings_found: parsed.performances.length,
      screenings_saved: saved,
      excluded_non_film: parsed.excludedNonFilm,
      excluded_placeholders: parsed.excludedPlaceholder,
      detail_warnings: detailWarnings,
      booking_resolution_warnings: bookingWarnings,
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, error: message }, 500);
  }
});
