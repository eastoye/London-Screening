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

const CINEMA_NAME = "Riverside Studios";
const MIN_SCREENINGS = 3;

const config: SpektrixConfig = {
  client: "riversidestudios",
  baseUrl: "https://spektrix.riversidestudios.co.uk",
  sourcePrefix: "riverside",
};

// Riverside classifies film screenings via attribute_EventType.
// Accept "Cinema" and "Event Cinema" types.
// Exclude Theatre, Television, Talks & Events, Comedy, Music, etc.
const CINEMA_EVENT_TYPES = new Set([
  "Cinema",
  "Event Cinema",
]);

function isCinemaEvent(event: SpektrixEvent): boolean {
  const eventType = (event.attributes.attribute_EventType as string) || "";
  return CINEMA_EVENT_TYPES.has(eventType);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-riverside] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for Riverside Studios.", blocked: true },
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
      `[import-riverside] events=${result.eventsCount} cinemaEvents=${result.cinemaEventsCount} instances=${result.instancesFetched} screenings=${result.screenings.length}`
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
    console.log(`[import-riverside] done: found=${result.screenings.length} saved=${saved}`);

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
