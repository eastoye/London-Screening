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
  fetchAllScreenings,
  type SpektrixConfig,
  type SpektrixEvent,
} from "../_shared/spektrixParser.ts";

const CINEMA_NAME = "Kiln Cinema";
const MIN_SCREENINGS = 3;

const config: SpektrixConfig = {
  client: "tricycle",
  baseUrl: "https://tickets.kilntheatre.com",
  sourcePrefix: "kiln",
};

// Kiln uses several attribute fields to classify cinema events.
// We accept events where any of these indicate "Cinema":
//   attribute_Category, attribute_Type, attribute_WebEventType, attribute_AccountCode
// We also accept "Alternative Cinema Content" (e.g. NT Live, Event Cinema).
function isCinemaEvent(event: SpektrixEvent): boolean {
  const category = (event.attributes.attribute_Category as string) || "";
  const type = (event.attributes.attribute_Type as string) || "";
  const webEventType = (event.attributes.attribute_WebEventType as string) || "";
  const accountCode = (event.attributes.attribute_AccountCode as string) || "";
  const artform = (event.attributes.attribute_TAAArtform as string) || "";

  // Must be tagged as Cinema in at least one classification field
  const isCinema =
    /cinema/i.test(category) ||
    /cinema/i.test(type) ||
    /cinema/i.test(webEventType) ||
    /cinema/i.test(accountCode);

  // Also accept Film artform events that are explicitly tagged Cinema
  if (!isCinema && /film/i.test(artform)) {
    return /cinema/i.test(webEventType) || /cinema/i.test(category);
  }

  return isCinema;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-kiln] starting at ${startedIso}`);

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
    return jsonResponse(
      { success: false, error: "Another import is already running for Kiln Cinema.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  try {
    const nowUtc = new Date();
    const result = await fetchAllScreenings(config, isCinemaEvent, {
      fromDate: nowUtc,
    });

    console.log(
      `[import-kiln] events=${result.eventsCount} cinemaEvents=${result.cinemaEventsCount} instances=${result.instancesFetched} screenings=${result.screenings.length}`
    );

    if (result.screenings.length < MIN_SCREENINGS) {
      const msg = `Unusually low screening count (${result.screenings.length}). Database left untouched.`;
      await endRun(ctx, runId, "failed", result.screenings.length, 0, msg);
      return jsonResponse(
        { success: false, error: msg, screenings_found: result.screenings.length },
        500
      );
    }

    const records: ScreeningRecord[] = result.screenings.map((s) => ({
      cinema_name: CINEMA_NAME,
      movie_title: s.movie_title,
      start_time: s.start_time_iso,
      booking_url: s.booking_url,
      format: s.format || (s.labels.length > 0 ? s.labels.join(", ") : null),
      sold_out: s.sold_out,
      source_reference: s.source_reference,
      last_seen_at: new Date().toISOString(),
    }));

    const { saved, errors } = await commitImport(ctx, records, nowUtc);
    if (errors.length > 0) {
      const msg = `Import errors: ${errors.join("; ")}`;
      await endRun(ctx, runId, "failed", result.screenings.length, saved, msg);
      return jsonResponse(
        { success: false, error: msg, screenings_found: result.screenings.length, screenings_saved: saved },
        500
      );
    }

    await endRun(ctx, runId, "success", result.screenings.length, saved);
    console.log(`[import-kiln] done: found=${result.screenings.length} saved=${saved}`);

    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: result.screenings.length,
      screenings_saved: saved,
      events_total: result.eventsCount,
      cinema_events: result.cinemaEventsCount,
      instances_fetched: result.instancesFetched,
      fetch_errors: result.errors.slice(0, 10),
      import_started_at: startedIso,
      import_completed_at: new Date().toISOString(),
      examples: result.screenings.slice(0, 5).map((s) => ({
        movie_title: s.movie_title,
        start_time: s.start_time_iso,
        source_reference: s.source_reference,
        booking_url: s.booking_url,
        screen: s.screen_name,
        venue: s.venue_name,
        format: s.format,
        labels: s.labels,
        sold_out: s.sold_out,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 500);
  }
});
