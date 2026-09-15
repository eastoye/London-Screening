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
import { CINEMA_NAME } from "./import-common.ts";
import { MIN_SCREENINGS, parseLexiScreenings } from "./parser.ts";

function duplicates(records: ScreeningRecord[], key: (record: ScreeningRecord) => string): string[] {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(key(record), (counts.get(key(record)) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ success: false, error: "Missing Supabase credentials" }, 500);

  const startedAt = new Date();
  const context: ImportRunContext = {
    supabase: createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }),
    cinemaName: CINEMA_NAME,
    minScreenings: MIN_SCREENINGS,
    startedAt,
  };
  const started = await startRun(context);
  if (started.blocked) return jsonResponse({ success: false, blocked: true, error: "Import already running" }, 409);
  if (!started.runId) return jsonResponse({ success: false, error: started.error ?? "Could not start import" }, 500);

  let found = 0;
  try {
    const now = new Date();
    const programme = await parseLexiScreenings(now);
    const records = programme.records;
    found = records.length;
    if (records.length < MIN_SCREENINGS) throw new Error(`Unusually low Lexi screening count (${records.length})`);
    const duplicateReferences = duplicates(records, (record) => record.source_reference);
    if (duplicateReferences.length) throw new Error(`Duplicate Lexi source references: ${duplicateReferences.slice(0, 5).join(", ")}`);
    const duplicateTitleTimes = duplicates(records, (record) => `${record.movie_title}\u0000${record.start_time}`);
    if (duplicateTitleTimes.length) throw new Error(`Duplicate Lexi title/time rows (${duplicateTitleTimes.length})`);

    const { count: previous, error: countError } = await context.supabase
      .from("screenings").select("id", { count: "exact", head: true })
      .eq("cinema_name", CINEMA_NAME).eq("active", true).gt("start_time", now.toISOString());
    if (countError) throw new Error(`Could not read previous Lexi count: ${countError.message}`);
    if ((previous ?? 0) >= 20 && records.length < Math.ceil((previous ?? 0) * 0.5)) {
      throw new Error(`Suspicious Lexi count drop from ${previous} to ${records.length}`);
    }

    const committed = await commitImport(context, records, now);
    if (committed.errors.length) throw new Error(committed.errors.join("; "));
    await endRun(context, started.runId, "success", found, committed.saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      source: "official-savoy-embedded-json",
      source_events: programme.sourceEvents,
      source_performances: programme.sourcePerformances,
      excluded_non_films: programme.excludedNonFilms,
      skipped_past: programme.skippedPast,
      screenings_found: found,
      screenings_saved: committed.saved,
      previous_active: previous ?? 0,
      metadata_population: {
        title_hints: records.filter((record) => record.film_title_hint).length,
        release_years: records.filter((record) => record.source_release_year).length,
        runtimes: records.filter((record) => record.source_runtime_minutes).length,
        directors: records.filter((record) => record.source_directors?.length).length,
        countries: records.filter((record) => record.source_countries?.length).length,
        artwork: records.filter((record) => record.verified_artwork_url).length,
        event_urls: records.filter((record) => record.source_event_url).length,
        screens: records.filter((record) => record.screen_name).length,
        labels: records.filter((record) => record.screening_label).length,
        known_availability: records.filter((record) => record.availability_status !== "unknown").length,
        sold_out: records.filter((record) => record.sold_out).length,
      },
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(context, started.runId, "failed", found, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
