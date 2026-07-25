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
  parseOlympicPage,
  fallbackSourceRef,
  type ParsedOlympicScreening,
} from "../_shared/olympicParser.ts";

const SELFRIDGES_URL = "https://www.thecinemaatselfridges.com/whats-on";
const POWER_STATION_URL = "https://www.thecinemainthepowerstation.com/whats-on";
const CINEMA_NAME_RUN = "Olympic Cinemas";
const MIN_SCREENINGS = 3;

const SELFRIDGES_BASE = "https://www.thecinemaatselfridges.com";
const POWER_STATION_BASE = "https://www.thecinemainthepowerstation.com";

interface VenueResult {
  cinema_name: string;
  prefix: string;
  found: number;
  saved: number;
  skipped_past: number;
}

const fetchOpts: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  redirect: "follow" as const,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-olympic-cinemas] starting at ${startedIso}`);

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
    cinemaName: CINEMA_NAME_RUN,
    minScreenings: MIN_SCREENINGS,
    startedAt,
  };

  const runStart = await startRun(ctx);
  if (runStart.blocked) {
    return jsonResponse(
      { success: false, error: "Another Olympic Cinemas import is already running.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  const nowUtc = new Date();
  const offsetMin = londonOffsetMinutes(nowUtc);
  const nowLondon = new Date(nowUtc.getTime() + offsetMin * 60 * 1000);

  // Fetch both pages. Both must succeed before any DB writes.
  let selfridgesHtml: string;
  let powerStationHtml: string;
  try {
    console.log("[import-olympic-cinemas] fetching Selfridges...");
    const resp1 = await fetch(SELFRIDGES_URL, fetchOpts);
    if (!resp1.ok) {
      const msg = `Failed to fetch Selfridges: HTTP ${resp1.status} ${resp1.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    selfridgesHtml = await resp1.text();
    console.log(`[import-olympic-cinemas] Selfridges fetched ${selfridgesHtml.length} bytes`);

    console.log("[import-olympic-cinemas] fetching Power Station...");
    const resp2 = await fetch(POWER_STATION_URL, fetchOpts);
    if (!resp2.ok) {
      const msg = `Failed to fetch Power Station: HTTP ${resp2.status} ${resp2.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    powerStationHtml = await resp2.text();
    console.log(`[import-olympic-cinemas] Power Station fetched ${powerStationHtml.length} bytes`);
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  // Parse both pages.
  let selfridgesParsed: ParsedOlympicScreening[] = [];
  let powerStationParsed: ParsedOlympicScreening[] = [];
  let powerStationDiagnostics = {
    venueHeadingsArches: 0,
    venueHeadingsPowerstation: 0,
    archesBookingButtons: 0,
    powerStationBookingButtons: 0,
  };
  try {
    const selfridgesResult = parseOlympicPage(selfridgesHtml, SELFRIDGES_BASE, nowLondon);
    selfridgesParsed = selfridgesResult.screenings;
    console.log(`[import-olympic-cinemas] Selfridges parsed ${selfridgesParsed.length} screenings`);

    const powerStationResult = parseOlympicPage(powerStationHtml, POWER_STATION_BASE, nowLondon);
    powerStationParsed = powerStationResult.screenings;
    powerStationDiagnostics = powerStationResult.diagnostics;
    console.log(`[import-olympic-cinemas] Power Station parsed ${powerStationParsed.length} screenings`);
    console.log(`[import-olympic-cinemas] diagnostics: ${JSON.stringify(powerStationDiagnostics)}`);
  } catch (err) {
    const msg = `Parse error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 500);
  }

  // Minimum-count validation: apply separately to Selfridges and Power Station.
  // Arches is exempt (it may genuinely have zero screenings).
  if (selfridgesParsed.length < MIN_SCREENINGS) {
    const msg = `Selfridges screening count too low (${selfridgesParsed.length}). Database left untouched.`;
    await endRun(ctx, runId, "failed", selfridgesParsed.length, 0, msg);
    return jsonResponse({ success: false, error: msg, selfridges_found: selfridgesParsed.length }, 500);
  }
  if (powerStationParsed.length < MIN_SCREENINGS) {
    const msg = `Power Station screening count too low (${powerStationParsed.length}). Database left untouched.`;
    await endRun(ctx, runId, "failed", powerStationParsed.length, 0, msg);
    return jsonResponse({ success: false, error: msg, power_station_found: powerStationParsed.length }, 500);
  }

  // Build per-venue record groups, then commit each venue separately so
  // that commitImport deactivates stale rows using the correct cinema_name.
  const venueResults: VenueResult[] = [];
  let totalSaved = 0;
  const allErrors: string[] = [];

  // Helper: build records for a venue from parsed screenings.
  const buildRecords = (
    parsed: ParsedOlympicScreening[],
    cinemaName: string,
    prefix: string
  ): ScreeningRecord[] =>
    parsed
      .filter(
        (p) =>
          p.start_time_iso !== null &&
          new Date(p.start_time_iso).getTime() > nowUtc.getTime()
      )
      .map((p) => {
        const sourceRef = p.booking_id
          ? `olympic:${prefix}:${p.booking_id}`
          : fallbackSourceRef(prefix, p.movie_title, p.start_time_iso!);
        return {
          cinema_name: cinemaName,
          movie_title: p.movie_title,
          start_time: p.start_time_iso!,
          booking_url: p.booking_url,
          format: p.status_label,
          sold_out: p.sold_out,
          source_reference: sourceRef,
          last_seen_at: new Date().toISOString(),
        };
      });

  // --- Selfridges ---
  {
    const cinemaName = "The Cinema at Selfridges";
    const prefix = "selfridges";
    const records = buildRecords(selfridgesParsed, cinemaName, prefix);
    const skippedPast = selfridgesParsed.length - records.length;
    const venueCtx: ImportRunContext = { ...ctx, cinemaName };
    const { saved, errors } = await commitImport(venueCtx, records, nowUtc);
    totalSaved += saved;
    allErrors.push(...errors);
    venueResults.push({
      cinema_name: cinemaName,
      prefix,
      found: selfridgesParsed.length,
      saved,
      skipped_past: skippedPast,
    });
  }

  // --- Power Station + Arches (from the same page, split by venue label) ---
  {
    const psPrefix = "power-station";
    const archesPrefix = "arches";
    const psCinemaName = "The Cinema in the Power Station";
    const archesCinemaName = "The Cinema in the Arches";

    const psParsed: ParsedOlympicScreening[] = [];
    const archesParsed: ParsedOlympicScreening[] = [];
    for (const p of powerStationParsed) {
      if (/arches/i.test(p.venue_label)) archesParsed.push(p);
      else psParsed.push(p);
    }

    // Power Station
    {
      const records = buildRecords(psParsed, psCinemaName, psPrefix);
      const skippedPast = psParsed.length - records.length;
      const venueCtx: ImportRunContext = { ...ctx, cinemaName: psCinemaName };
      const { saved, errors } = await commitImport(venueCtx, records, nowUtc);
      totalSaved += saved;
      allErrors.push(...errors);
      venueResults.push({
        cinema_name: psCinemaName,
        prefix: psPrefix,
        found: psParsed.length,
        saved,
        skipped_past: skippedPast,
      });
    }

    // Arches (no minimum-count requirement).
    // Only commit if the parser found Arches screenings OR the diagnostics
    // confirm the page genuinely contains Arches booking buttons. This
    // prevents deactivating existing Arches rows when the parser returns
    // zero due to a parse failure rather than a genuine absence.
    const archesPresentOnPage =
      archesParsed.length > 0 ||
      powerStationDiagnostics.archesBookingButtons > 0 ||
      powerStationDiagnostics.venueHeadingsArches > 0;
    if (archesPresentOnPage) {
      const records = buildRecords(archesParsed, archesCinemaName, archesPrefix);
      const skippedPast = archesParsed.length - records.length;
      const venueCtx: ImportRunContext = { ...ctx, cinemaName: archesCinemaName };
      const { saved, errors } = await commitImport(venueCtx, records, nowUtc);
      totalSaved += saved;
      allErrors.push(...errors);
      venueResults.push({
        cinema_name: archesCinemaName,
        prefix: archesPrefix,
        found: archesParsed.length,
        saved,
        skipped_past: skippedPast,
      });
    } else {
      console.log("[import-olympic-cinemas] Arches not present on page; skipping commit to preserve existing rows.");
      venueResults.push({
        cinema_name: archesCinemaName,
        prefix: archesPrefix,
        found: 0,
        saved: 0,
        skipped_past: 0,
      });
    }
  }

  if (allErrors.length > 0) {
    const msg = `Import errors: ${allErrors.join("; ")}`;
    await endRun(ctx, runId, "failed", totalSaved, totalSaved, msg);
    return jsonResponse(
      { success: false, error: msg, screenings_saved: totalSaved },
      500
    );
  }

  await endRun(ctx, runId, "success", totalSaved, totalSaved);
  console.log(`[import-olympic-cinemas] done: total saved=${totalSaved}`);

  // Collect all saved records for examples (re-query for display).
  const allRecords: ScreeningRecord[] = [];
  for (const vr of venueResults) {
    const { data } = await supabase
      .from("screenings")
      .select("cinema_name,movie_title,start_time,booking_url,format,sold_out,source_reference")
      .eq("cinema_name", vr.cinema_name)
      .eq("active", true)
      .order("start_time", { ascending: true })
      .limit(5);
    if (data) allRecords.push(...(data as ScreeningRecord[]));
  }

  const examples: Record<string, ScreeningRecord[]> = {};
  for (const vr of venueResults) {
    examples[vr.cinema_name] = allRecords
      .filter((r) => r.cinema_name === vr.cinema_name)
      .slice(0, 5);
  }

  return jsonResponse({
    success: true,
    venues: venueResults.map((vr) => ({
      cinema_name: vr.cinema_name,
      screenings_found: vr.found,
      screenings_saved: vr.saved,
      skipped_past: vr.skipped_past,
    })),
    diagnostics: powerStationDiagnostics,
    total_screenings_saved: totalSaved,
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
    examples,
  });
});
