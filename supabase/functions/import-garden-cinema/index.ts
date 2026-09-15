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
import { parseGardenPage } from "./parser.ts";

const PROGRAMME_URL = "https://www.thegardencinema.co.uk/";
const CINEMA_NAME = "The Garden Cinema";
const MIN_SCREENINGS = 10;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const FETCH_TIMEOUT_MS = 15_000;

async function fetchProgramme(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(PROGRAMME_URL, {
      headers: {
        "User-Agent": "LondonScreenings/2.0 (+https://github.com/eastoye/London-Screening)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Programme fetch failed: HTTP ${response.status}`);
    const html = await response.text();
    if (html.length < 50_000 || !html.includes("TcsPerformance_") || !html.includes("films-list__by-date")) {
      throw new Error("Programme response was incomplete or no longer has the expected Savoy markup.");
    }
    return html;
  } finally {
    clearTimeout(timeout);
  }
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

function duplicateError(records: ScreeningRecord[]): string | null {
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
  if (runStart.blocked) return jsonResponse({ success: false, blocked: true, error: "Import already running." }, 409);
  if (runStart.error || !runStart.runId) return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  const runId = runStart.runId;
  let found = 0;

  try {
    const parsed = parseGardenPage(await fetchProgramme());
    found = parsed.screenings.length;
    if (parsed.errors.length) throw new Error(`Programme parse failed: ${parsed.errors.slice(0, 5).join(" | ")}`);

    const nowUtc = new Date();
    const future = parsed.screenings.filter((screening) => new Date(screening.startTimeIso).getTime() > nowUtc.getTime());
    if (future.length < MIN_SCREENINGS) throw new Error(`Unusually low screening count (${future.length}); database left untouched.`);
    const previousCount = await previousActiveCount(ctx, nowUtc);
    if (previousCount >= RATIO_GUARD_MIN_EXISTING && future.length < Math.ceil(previousCount * MIN_EXPECTED_RATIO)) {
      throw new Error(`Count-drop guard blocked import: ${future.length} new future screenings vs ${previousCount} active.`);
    }

    const records: ScreeningRecord[] = future.map((screening) => ({
      cinema_name: CINEMA_NAME,
      movie_title: screening.movieTitle,
      film_title_hint: screening.filmTitleHint,
      start_time: screening.startTimeIso,
      booking_url: screening.bookingUrl,
      format: screening.projectionFormats.length
        ? screening.projectionFormats.map((value) => value === "imax" ? "IMAX" : value).join(", ")
        : null,
      sold_out: screening.soldOut,
      projection_formats: screening.projectionFormats,
      accessibility_features: screening.accessibilityFeatures,
      programme_types: screening.programmeTypes,
      availability_status: screening.availabilityStatus,
      source_release_year: screening.sourceReleaseYear,
      source_runtime_minutes: screening.sourceRuntimeMinutes,
      source_directors: screening.sourceDirectors,
      source_countries: screening.sourceCountries,
      source_event_url: screening.sourceEventUrl,
      screen_name: null,
      screening_label: screening.screeningLabel,
      screening_tags: screening.screeningTags,
      verified_artwork_url: screening.artworkUrl,
      source_reference: screening.sourceReference,
      last_seen_at: startedAt.toISOString(),
    }));

    const duplicate = duplicateError(records);
    if (duplicate) throw new Error(duplicate);
    const result = await commitImport(ctx, records, nowUtc);
    if (result.errors.length) throw new Error(`Import errors: ${result.errors.join("; ")}`);
    await endRun(ctx, runId, "success", future.length, result.saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: future.length,
      screenings_saved: result.saved,
      previous_active: previousCount,
      excluded_non_film: parsed.excludedNonFilm,
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", found, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
