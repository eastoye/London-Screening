// JW3 Cinema importer.
//
// Source: Spektrix API (client "jw3").
//   events:  https://system.spektrix.com/jw3/api/v3/events
//   instances: https://system.spektrix.com/jw3/api/v3/events/{eventId}/instances
//   plans/venues: https://system.spektrix.com/jw3/api/v3/plans / /venues
//
// The JW3 Spektrix account contains many non-cinema events (language classes,
// talks, workshops, music, family activities, etc.). We filter to cinema
// screenings using attribute_Genre == "Cinema", which JW3 applies consistently
// to all film/cinema events.
//
// SOLD-OUT SAFETY: JW3 Spektrix instances use isOnSale = false for several
// non-sold-out states (sales not yet open, online sales ended, members-only,
// past performances). The shared spektrixParser.isSoldOut() would treat a
// future !isOnSale instance as sold out — which violates the task's sold-out
// safety rules. We therefore force sold_out = false on every JW3 screening.
// JW3's Spektrix data has no explicit "sold out" flag, so per the rules we
// default to false (uncertain → not sold out). A cancelled instance is still
// skipped outright by fetchAllScreenings.
//
// source_reference = jw3:spektrix:{EventInstanceId}

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
import {
  extractFormat,
  extractLabels,
  fetchEvents,
  fetchInstances,
  parseStartTime,
  type SpektrixConfig,
  type SpektrixEvent,
  type SpektrixInstance,
} from "../_shared/spektrixParser.ts";

const CINEMA_NAME = "JW3 Cinema";
const MIN_SCREENINGS = 3;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const EVENT_END_BUFFER_MS = 2 * 60 * 60 * 1000;
const FETCH_BATCH_SIZE = 5;

const config: SpektrixConfig = {
  client: "jw3",
  baseUrl: "https://system.spektrix.com",
  sourcePrefix: "jw3",
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
      batch.map(async (event) => ({
        event,
        instances: await fetchInstances(config, event.id),
      }))
    );
    for (const result of results) {
      for (const instance of result.instances) {
        pairs.push({ event: result.event, instance });
      }
    }
  }
  return pairs;
}

async function getPreviousActiveCount(
  ctx: ImportRunContext,
  nowUtc: Date
): Promise<number> {
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

    const pairs = await fetchCandidateInstances(candidates);
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

      const labels = extractLabels(instance, event);
      const explicitFormat = extractFormat(instance, event, labels);
      records.push({
        cinema_name: CINEMA_NAME,
        movie_title: event.name.trim(),
        start_time: startTime,
        booking_url: `https://www.jw3.org.uk/spektrix/ChooseSeats?EventInstanceId=${encodeURIComponent(instance.id)}`,
        format: explicitFormat ?? (labels.length > 0 ? labels.join(", ") : null),
        // Spektrix isOnSale=false can mean off-sale or not-yet-on-sale.
        // The API does not explicitly confirm sold out, so keep this false.
        sold_out: false,
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
    if (
      previousActive >= RATIO_GUARD_MIN_EXISTING &&
      records.length < ratioFloor
    ) {
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

