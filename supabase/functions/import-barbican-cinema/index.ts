import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonOffsetMinutes,
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

const CINEMA_NAME = "Barbican Cinema";
const MIN_SCREENINGS = 5;

const config: SpektrixConfig = {
  client: "barbicancentre",
  baseUrl: "https://tickets.barbican.org.uk",
  sourcePrefix: "barbican",
};

// Barbican event types that represent genuine cinema screenings.
// Excludes concerts, theatre, dance, talks, exhibitions, memberships, etc.
const CINEMA_EVENT_TYPES = new Set([
  "Screening - Film",
  "Screening + Workshop",
  "Talk + Screening",
  "Film and live music",
  "Relaxed Screening",
  "Arts Cinema",
]);

// Venue names that are genuine cinema screens.
const CINEMA_VENUES = new Set([
  "Cinema 1",
  "Cinema 2",
  "Cinema 3",
]);

// Filter to only cinema screenings. We check both the event type
// and the primary art form to catch all cinema events.
function isCinemaEvent(event: SpektrixEvent): boolean {
  const eventType = (event.attributes.attribute_EventType as string) || "";
  const artForm = (event.attributes.attribute_PrimaryArtForm as string) || "";

  // Must be a cinema/film event type
  if (!CINEMA_EVENT_TYPES.has(eventType)) {
    // Also accept if PrimaryArtForm is "Cinema" and the event type
    // contains "Screening" or "Film"
    if (artForm !== "Cinema") return false;
    if (!/screening|film/i.test(eventType)) return false;
  }

  // Exclude membership products, headset reservations, lounge/hospitality
  const settlement = (event.attributes.attribute_Settlement as string) || "";
  if (/membership|headset|lounge|hospitality/i.test(settlement)) return false;

  // Exclude events with "Ticketbank" attribute that are not films
  // (Ticketbank is used for free/reserved events that are not screenings)
  const suppEvent = event.attributes.attribute_SuppEvent;
  if (suppEvent === true) return false;

  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-barbican] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for Barbican Cinema.", blocked: true },
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
      `[import-barbican] events=${result.eventsCount} cinemaEvents=${result.cinemaEventsCount} instances=${result.instancesFetched} screenings=${result.screenings.length}`
    );

    if (result.screenings.length < MIN_SCREENINGS) {
      const msg = `Unusually low screening count (${result.screenings.length}). Database left untouched.`;
      await endRun(ctx, runId, "failed", result.screenings.length, 0, msg);
      return jsonResponse(
        { success: false, error: msg, screenings_found: result.screenings.length },
        500
      );
    }

    // Build ScreeningRecords
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
    console.log(`[import-barbican] done: found=${result.screenings.length} saved=${saved}`);

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
