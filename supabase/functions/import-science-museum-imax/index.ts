import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  discoverOfficialFilmPages,
  parseOfficialFilmPage,
  parseTicketResponse,
  validateScreenings,
  type OfficialFilm,
  type ParsedScreening,
} from "./parser.ts";

const CINEMA_NAME = "Science Museum IMAX";
const IMAX_PAGE = "https://www.sciencemuseum.org.uk/imax-cinema";
const SEASON_PAGE = "https://www.sciencemuseum.org.uk/see-and-do/imax-70mm-season";
const TICKET_API = "https://my.sciencemuseum.org.uk/api/products/productionseasons";
const MIN_SCREENINGS = 1;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const FETCH_TIMEOUT_MS = 25_000;
const HORIZON_DAYS = 180;

async function fetchHtml(url: string, minimumBytes: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "LondonScreenings/2.0 (+https://github.com/eastoye/London-Screening)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const html = await response.text();
    if (html.length < minimumBytes) throw new Error(`${url} returned an unexpectedly small page (${html.length} bytes)`);
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

function dateForApi(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T00:00`;
}

async function fetchTicketData(keywordId: string, now: Date): Promise<unknown> {
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 86_400_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(TICKET_API, {
      method: "POST",
      headers: {
        "User-Agent": "LondonScreenings/2.0 (+https://github.com/eastoye/London-Screening)",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: dateForApi(now),
        endDate: dateForApi(horizon),
        productionSeasonIdFilter: [],
        keywordIds: [keywordId],
        keywords: [],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Science Museum ticket API returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length < 50 || !text.trimStart().startsWith("{")) {
      throw new Error(`Science Museum ticket API returned an incomplete response (${text.length} bytes)`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Science Museum ticket API returned invalid JSON");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOfficialFilms(): Promise<{ films: OfficialFilm[]; candidatePages: number; comingSoon: number }> {
  const [imaxHtml, seasonHtml] = await Promise.all([
    fetchHtml(IMAX_PAGE, 50_000),
    fetchHtml(SEASON_PAGE, 30_000),
  ]);
  const discovery = discoverOfficialFilmPages(imaxHtml, seasonHtml);
  if (discovery.errors.length) throw new Error(`Official film discovery failed: ${discovery.errors.join(" | ")}`);
  const pages = await Promise.all(discovery.urls.map(async (url) => ({ url, html: await fetchHtml(url, 20_000) })));
  const films: OfficialFilm[] = [];
  let comingSoon = 0;
  for (const page of pages) {
    const film = parseOfficialFilmPage(page.html, page.url);
    if (!film) throw new Error(`Official film page was incomplete or no longer identified as an IMAX screening: ${page.url}`);
    if (!film.bookingKeywordId) { comingSoon++; continue; }
    films.push(film);
  }
  if (films.length === 0) throw new Error("No official blockbuster film currently exposes a ticket-feed identifier; database left untouched.");
  return { films, candidatePages: discovery.urls.length, comingSoon };
}

async function parseLiveSource(now: Date): Promise<{
  screenings: ParsedScreening[];
  candidatePages: number;
  comingSoon: number;
  sourcePerformances: number;
}> {
  const official = await fetchOfficialFilms();
  const screenings: ParsedScreening[] = [];
  let sourcePerformances = 0;
  for (const film of official.films) {
    const result = parseTicketResponse(await fetchTicketData(film.bookingKeywordId!, now), film, now);
    if (result.errors.length) throw new Error(`Ticket-feed parse failed: ${result.errors.slice(0, 8).join(" | ")}`);
    sourcePerformances += result.sourcePerformances;
    screenings.push(...result.screenings);
  }
  const errors = validateScreenings(screenings);
  if (errors.length) throw new Error(`Screening validation failed: ${errors.slice(0, 8).join(" | ")}`);
  if (screenings.length < MIN_SCREENINGS) throw new Error(`Unusually low screening count (${screenings.length}); database left untouched.`);
  return { ...official, screenings, sourcePerformances };
}

async function previousActiveCount(ctx: ImportRunContext, now: Date): Promise<number> {
  const { count, error } = await ctx.supabase.from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME).eq("active", true).gt("start_time", now.toISOString());
  if (error) throw new Error(`Could not read previous screening count: ${error.message}`);
  return count ?? 0;
}

async function preserveExistingReferences(ctx: ImportRunContext, records: ScreeningRecord[], now: Date): Promise<void> {
  const { data, error } = await ctx.supabase.from("screenings")
    .select("source_reference,movie_title,start_time")
    .eq("cinema_name", CINEMA_NAME).gt("start_time", now.toISOString());
  if (error) throw new Error(`Could not read existing Science Museum identities: ${error.message}`);
  const existing = new Map<string, string>();
  for (const row of data ?? []) {
    existing.set(`${String(row.movie_title).toLowerCase()}|${new Date(row.start_time).toISOString()}`, row.source_reference);
  }
  for (const record of records) {
    record.source_reference = existing.get(`${record.movie_title.toLowerCase()}|${new Date(record.start_time).toISOString()}`)
      ?? record.source_reference;
  }
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
  if (runStart.blocked) return jsonResponse({ success: false, blocked: true, error: "Import already running." }, 409);
  if (runStart.error || !runStart.runId) return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  const runId = runStart.runId;
  let found = 0;

  try {
    const parsed = await parseLiveSource(startedAt);
    found = parsed.screenings.length;
    const now = new Date();
    const previousCount = await previousActiveCount(ctx, now);
    if (previousCount >= RATIO_GUARD_MIN_EXISTING && found < Math.ceil(previousCount * MIN_EXPECTED_RATIO)) {
      throw new Error(`Count-drop guard blocked import: ${found} new future screenings vs ${previousCount} active.`);
    }
    const records: ScreeningRecord[] = parsed.screenings.map((row) => ({
      cinema_name: CINEMA_NAME,
      movie_title: row.movieTitle,
      film_title_hint: row.filmTitleHint,
      start_time: row.startTimeIso,
      booking_url: row.bookingUrl,
      format: row.displayFormat,
      sold_out: row.soldOut,
      projection_formats: row.projectionFormats,
      accessibility_features: row.accessibilityFeatures,
      programme_types: row.programmeTypes,
      availability_status: row.availabilityStatus,
      source_release_year: row.sourceReleaseYear,
      source_runtime_minutes: row.sourceRuntimeMinutes,
      source_directors: row.sourceDirectors,
      source_countries: row.sourceCountries,
      source_event_url: row.sourceEventUrl,
      screen_name: row.screenName,
      screening_label: row.screeningLabel,
      screening_tags: row.screeningTags,
      verified_artwork_url: row.artworkUrl,
      source_reference: row.sourceReference,
      last_seen_at: startedAt.toISOString(),
    }));
    await preserveExistingReferences(ctx, records, now);
    if (new Set(records.map((row) => row.source_reference)).size !== records.length) {
      throw new Error("Existing-reference preservation introduced duplicate source references.");
    }
    const committed = await commitImport(ctx, records, now);
    if (committed.errors.length) throw new Error(`Import errors: ${committed.errors.join("; ")}`);
    await endRun(ctx, runId, "success", records.length, committed.saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: records.length,
      screenings_saved: committed.saved,
      previous_active: previousCount,
      candidate_official_pages: parsed.candidatePages,
      coming_soon_without_tickets: parsed.comingSoon,
      source_performances_seen: parsed.sourcePerformances,
      metadata: {
        sold_out: records.filter((row) => row.sold_out).length,
        available: records.filter((row) => row.availability_status === "available").length,
        unknown_availability: records.filter((row) => row.availability_status === "unknown").length,
        release_years: records.filter((row) => row.source_release_year).length,
        runtimes: records.filter((row) => row.source_runtime_minutes).length,
        directors: records.filter((row) => row.source_directors?.length).length,
        artwork: records.filter((row) => row.verified_artwork_url).length,
        stable_performance_ids: records.filter((row) => /^science-museum-imax:\d+$/.test(row.source_reference)).length,
      },
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", found, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
