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
import { parseNickelPage } from "./parser.ts";

const PROGRAMME_URL = "https://thenickel.co.uk/";
const CINEMA_NAME = "The Nickel";
const MIN_SCREENINGS = 3;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const FETCH_TIMEOUT_MS = 30_000;

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
    if (html.length < 50_000 || !html.includes("initialScreenings") || !html.includes("screeningDate")) {
      throw new Error("Programme response was incomplete or no longer contains the expected Next.js data.");
    }
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

async function previousActiveCount(ctx: ImportRunContext, nowUtc: Date): Promise<number> {
  const { count, error } = await ctx.supabase.from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME).eq("active", true).gt("start_time", nowUtc.toISOString());
  if (error) throw new Error(`Could not read previous screening count: ${error.message}`);
  return count ?? 0;
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
    const parsed = parseNickelPage(await fetchProgramme(), startedAt);
    found = parsed.screenings.length;
    if (parsed.errors.length) throw new Error(`Programme parse failed: ${parsed.errors.slice(0, 8).join(" | ")}`);
    if (parsed.sourceCount < MIN_SCREENINGS || parsed.screenings.length < MIN_SCREENINGS) {
      throw new Error(`Unusually low screening count (${parsed.screenings.length}); database left untouched.`);
    }
    const nowUtc = new Date();
    const previousCount = await previousActiveCount(ctx, nowUtc);
    if (previousCount >= RATIO_GUARD_MIN_EXISTING && parsed.screenings.length < Math.ceil(previousCount * MIN_EXPECTED_RATIO)) {
      throw new Error(`Count-drop guard blocked import: ${parsed.screenings.length} new future screenings vs ${previousCount} active.`);
    }

    const records: ScreeningRecord[] = parsed.screenings.map((screening) => ({
      cinema_name: CINEMA_NAME,
      movie_title: screening.movieTitle,
      film_title_hint: screening.filmTitleHint,
      start_time: screening.startTimeIso,
      booking_url: screening.bookingUrl,
      format: screening.displayFormat,
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
    const result = await commitImport(ctx, records, nowUtc);
    if (result.errors.length) throw new Error(`Import errors: ${result.errors.join("; ")}`);
    await endRun(ctx, runId, "success", records.length, result.saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: records.length,
      screenings_saved: result.saved,
      source_screenings: parsed.sourceCount,
      previous_active: previousCount,
      metadata: {
        film_title_hints: records.filter((row) => row.film_title_hint).length,
        release_years: records.filter((row) => row.source_release_year).length,
        runtimes: records.filter((row) => row.source_runtime_minutes).length,
        directors: records.filter((row) => row.source_directors?.length).length,
        countries: records.filter((row) => row.source_countries?.length).length,
        artwork: records.filter((row) => row.verified_artwork_url).length,
        known_availability: records.filter((row) => row.availability_status !== "unknown").length,
      },
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", found, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
