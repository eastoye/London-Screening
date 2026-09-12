import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  commitImport,
  corsHeaders,
  endRun,
  jsonResponse,
  londonToUtc,
  startRun,
  type ImportRunContext,
  type ScreeningRecord,
} from "../_shared/importSafety.ts";
import { parseProgramme, validateScreenings } from "./parser.ts";

const PROGRAMME_URL = "https://riocinema.org.uk/Rio.dll/WhatsOn";
const CINEMA_NAME = "Rio Cinema";
const MIN_SCREENINGS = 3;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const FETCH_TIMEOUT_MS = 25_000;

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
    if (!response.ok) throw new Error(`Rio programme returned HTTP ${response.status}.`);
    const html = await response.text();
    if (html.length < 10_000) throw new Error(`Rio programme was unexpectedly small (${html.length} bytes).`);
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

async function previousActiveCount(ctx: ImportRunContext, now: Date): Promise<number> {
  const { count, error } = await ctx.supabase.from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME)
    .eq("active", true)
    .gt("start_time", now.toISOString());
  if (error) throw new Error(`Could not read previous Rio count: ${error.message}`);
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
  if (runStart.blocked) return jsonResponse({ success: false, blocked: true, error: "Import already running." }, 409);
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }

  const runId = runStart.runId;
  let found = 0;
  try {
    const now = new Date();
    const parsed = parseProgramme(await fetchProgramme(), now, londonToUtc);
    found = parsed.screenings.length;
    if (parsed.errors.length) {
      throw new Error(`Rio source was incomplete: ${parsed.errors.slice(0, 8).join(" | ")}`);
    }
    const validationErrors = validateScreenings(parsed.screenings);
    if (validationErrors.length) {
      throw new Error(`Rio validation failed: ${validationErrors.slice(0, 8).join(" | ")}`);
    }
    if (found < MIN_SCREENINGS) {
      throw new Error(`Unusually low Rio screening count (${found}); database left untouched.`);
    }

    const previousActive = await previousActiveCount(ctx, now);
    if (
      previousActive >= RATIO_GUARD_MIN_EXISTING &&
      found < Math.ceil(previousActive * MIN_EXPECTED_RATIO)
    ) {
      throw new Error(`Count-drop guard blocked import: ${found} new screenings vs ${previousActive} active.`);
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

    const committed = await commitImport(ctx, records, now);
    if (committed.errors.length) throw new Error(`Import errors: ${committed.errors.join("; ")}`);
    await endRun(ctx, runId, "success", found, committed.saved);

    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: found,
      screenings_saved: committed.saved,
      previous_active: previousActive,
      events_in_source: parsed.totalEvents,
      performances_in_source: parsed.totalPerformances,
      future_performances_in_source: parsed.futurePerformances,
      metadata: {
        title_hints: records.filter((row) => row.film_title_hint).length,
        release_years: records.filter((row) => row.source_release_year).length,
        runtimes: records.filter((row) => row.source_runtime_minutes).length,
        directors: records.filter((row) => row.source_directors?.length).length,
        countries: records.filter((row) => row.source_countries?.length).length,
        artwork: records.filter((row) => row.verified_artwork_url).length,
        screens: records.filter((row) => row.screen_name).length,
        projection_formats: records.filter((row) => row.projection_formats?.length).length,
        accessibility: records.filter((row) => row.accessibility_features?.length).length,
        programme_types: records.filter((row) => row.programme_types?.length).length,
        screening_tags: records.filter((row) => row.screening_tags?.length).length,
        available: records.filter((row) => row.availability_status === "available").length,
        sold_out: records.filter((row) => row.availability_status === "sold_out").length,
        unknown_availability: records.filter((row) => row.availability_status === "unknown").length,
      },
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", found, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
