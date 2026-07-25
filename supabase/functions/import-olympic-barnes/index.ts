// Olympic Cinema Barnes importer.
//
// Source: https://www.olympiccinema.com/whats-on
// Provider: mycloudcinema (same platform as the other Olympic venues).
//
// This is a SEPARATE importer from import-olympic-cinemas (which handles
// Selfridges, Power Station and Arches). Barnes is isolated so that the
// working multi-venue importer cannot be affected, and so that Barnes
// screenings use the cinema_name "Olympic Cinema Barnes" and a Barnes-only
// source_reference prefix.
//
// The olympiccinema.com/whats-on page is Barnes-only: its date-sections
// contain film links and mycloudcinema booking buttons with no venue h6
// headings (the Selfridges/Power Station references on the page are only in
// the site navigation, not in the programme sections). The shared
// parseOlympicPage() parser handles the date-section + booking-button markup
// directly. All parsed screenings are treated as Barnes.
//
// Booking URLs are mycloudcinema (#/book/{id}) and the numeric booking id is
// used as the stable source_reference: olympic:barnes:{bookingId}.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  commitImport,
  corsHeaders,
  endRun,
  jsonResponse,
  londonOffsetMinutes,
  startRun,
  type ImportRunContext,
  type ScreeningRecord,
} from "../_shared/importSafety.ts";
import { parseOlympicPage } from "../_shared/olympicParser.ts";

const PROGRAMME_URL = "https://www.olympiccinema.com/whats-on";
const BASE_URL = "https://www.olympiccinema.com";
const CINEMA_NAME = "Olympic Cinema Barnes";
const SOURCE_PREFIX = "olympic:barnes";
const MIN_SCREENINGS = 3;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;

const fetchOptions: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  redirect: "follow",
};

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
    const response = await fetch(PROGRAMME_URL, fetchOptions);
    if (!response.ok) throw new Error(`Programme fetch returned HTTP ${response.status}`);
    const html = await response.text();
    if (html.length < 10_000) throw new Error(`Programme response was too small (${html.length} bytes)`);

    const nowUtc = new Date();
    const londonOffset = londonOffsetMinutes(nowUtc);
    const nowLondon = new Date(nowUtc.getTime() + londonOffset * 60_000);
    const parsed = parseOlympicPage(html, BASE_URL, nowLondon);
    const parseErrors = parsed.screenings
      .filter((screening) => screening.parse_error)
      .map((screening) => screening.parse_error as string);
    if (parseErrors.length > 0) {
      throw new Error(`Programme parse was incomplete: ${parseErrors.slice(0, 5).join("; ")}`);
    }

    let ignoredWithoutPerformanceId = 0;
    const records: ScreeningRecord[] = [];
    for (const screening of parsed.screenings) {
      if (
        !screening.start_time_iso ||
        new Date(screening.start_time_iso).getTime() <= nowUtc.getTime()
      ) {
        continue;
      }
      if (!screening.booking_id || !screening.booking_url) {
        ignoredWithoutPerformanceId++;
        continue;
      }
      records.push({
        cinema_name: CINEMA_NAME,
        movie_title: screening.movie_title,
        start_time: screening.start_time_iso,
        booking_url: screening.booking_url,
        format: screening.status_label,
        sold_out:
          screening.sold_out && /sold[ -]?out/i.test(screening.status_label ?? ""),
        source_reference: `${SOURCE_PREFIX}:${screening.booking_id}`,
        last_seen_at: nowUtc.toISOString(),
      });
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
      parser_results: parsed.screenings.length,
      ignored_without_performance_id: ignoredWithoutPerformanceId,
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

