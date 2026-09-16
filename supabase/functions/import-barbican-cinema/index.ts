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
    return jsonResponse(
      { success: false, error: "Missing Supabase credentials." },
      500,
    );
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
      {
        success: false,
        error: "Another Olympic Cinemas import is already running.",
        blocked: true,
      },
      409,
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse(
      {
        success: false,
        error: runStart.error ?? "Could not start run.",
      },
      500,
    );
  }
  const runId = runStart.runId;

  const nowUtc = new Date();
  const offsetMin = londonOffsetMinutes(nowUtc);
  const nowLondon = new Date(nowUtc.getTime() + offsetMin * 60 * 1000);

  let selfridgesHtml: string;
  let powerStationHtml: string;

  try {
    console.log("[import-olympic-cinemas] fetching Selfridges...");
    const selfridgesResponse = await fetch(SELFRIDGES_URL, fetchOpts);
    if (!selfridgesResponse.ok) {
      const message =
        `Failed to fetch Selfridges: HTTP ${selfridgesResponse.status} ${selfridgesResponse.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, message);
      return jsonResponse({ success: false, error: message }, 502);
    }
    selfridgesHtml = await selfridgesResponse.text();
    console.log(
      `[import-olympic-cinemas] Selfridges fetched ${selfridgesHtml.length} bytes`,
    );

    console.log("[import-olympic-cinemas] fetching Power Station...");
    const powerStationResponse = await fetch(POWER_STATION_URL, fetchOpts);
    if (!powerStationResponse.ok) {
      const message =
        `Failed to fetch Power Station: HTTP ${powerStationResponse.status} ${powerStationResponse.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, message);
      return jsonResponse({ success: false, error: message }, 502);
    }
    powerStationHtml = await powerStationResponse.text();
    console.log(
      `[import-olympic-cinemas] Power Station fetched ${powerStationHtml.length} bytes`,
    );
  } catch (error) {
    const message =
      `Network error: ${error instanceof Error ? error.message : String(error)}`;
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, error: message }, 502);
  }

  let selfridgesParsed: ParsedOlympicScreening[] = [];
  let powerStationParsed: ParsedOlympicScreening[] = [];
  let powerStationDiagnostics = {
    venueHeadingsArches: 0,
    venueHeadingsPowerstation: 0,
    archesBookingButtons: 0,
    powerStationBookingButtons: 0,
  };

  try {
    const selfridgesResult = parseOlympicPage(
      selfridgesHtml,
      SELFRIDGES_BASE,
      nowLondon,
    );
    selfridgesParsed = selfridgesResult.screenings;
    console.log(
      `[import-olympic-cinemas] Selfridges parsed ${selfridgesParsed.length} screenings`,
    );

    const powerStationResult = parseOlympicPage(
      powerStationHtml,
      POWER_STATION_BASE,
      nowLondon,
    );
    powerStationParsed = powerStationResult.screenings;
    powerStationDiagnostics = powerStationResult.diagnostics;
    console.log(
      `[import-olympic-cinemas] Power Station parsed ${powerStationParsed.length} screenings`,
    );
    console.log(
      `[import-olympic-cinemas] diagnostics: ${JSON.stringify(powerStationDiagnostics)}`,
    );
  } catch (error) {
    const message =
      `Parse error: ${error instanceof Error ? error.message : String(error)}`;
    await endRun(ctx, runId, "failed", 0, 0, message);
    return jsonResponse({ success: false, error: message }, 500);
  }

  if (selfridgesParsed.length < MIN_SCREENINGS) {
    const message =
      `Selfridges screening count too low (${selfridgesParsed.length}). Database left untouched.`;
    await endRun(ctx, runId, "failed", selfridgesParsed.length, 0, message);
    return jsonResponse(
      {
        success: false,
        error: message,
        selfridges_found: selfridgesParsed.length,
      },
      500,
    );
  }

  if (powerStationParsed.length < MIN_SCREENINGS) {
    const message =
      `Power Station screening count too low (${powerStationParsed.length}). Database left untouched.`;
    await endRun(ctx, runId, "failed", powerStationParsed.length, 0, message);
    return jsonResponse(
      {
        success: false,
        error: message,
        power_station_found: powerStationParsed.length,
      },
      500,
    );
  }

  const venueResults: VenueResult[] = [];
  let totalSaved = 0;
  const allErrors: string[] = [];

  const buildRecords = (
    parsed: ParsedOlympicScreening[],
    cinemaName: string,
    prefix: string,
  ): ScreeningRecord[] =>
    parsed
      .filter(
        (screening) =>
          screening.start_time_iso !== null &&
          new Date(screening.start_time_iso).getTime() > nowUtc.getTime(),
      )
      .map((screening) => {
        const sourceReference = screening.booking_id
          ? `olympic:${prefix}:${screening.booking_id}`
          : fallbackSourceRef(
              prefix,
              screening.movie_title,
              screening.start_time_iso!,
            );

        return {
          cinema_name: cinemaName,
          movie_title: screening.movie_title,
          start_time: screening.start_time_iso!,
          booking_url: screening.booking_url,
          format: screening.format,
          sold_out: screening.sold_out,
          projection_formats: screening.projection_formats,
          accessibility_features: screening.accessibility_features,
          programme_types: screening.programme_types,
          availability_status: screening.availability_status,
          source_event_url: screening.film_url,
          screening_label: screening.screening_label,
          screening_tags: screening.screening_tags,
          source_reference: sourceReference,
          last_seen_at: startedAt.toISOString(),
        };
      });

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

  {
    const powerStationPrefix = "power-station";
    const archesPrefix = "arches";
    const powerStationCinemaName = "The Cinema in the Power Station";
    const archesCinemaName = "The Cinema in the Arches";

    const powerStationOnly: ParsedOlympicScreening[] = [];
    const archesOnly: ParsedOlympicScreening[] = [];

    for (const screening of powerStationParsed) {
      if (/arches/i.test(screening.venue_label)) {
        archesOnly.push(screening);
      } else {
        powerStationOnly.push(screening);
      }
    }

    {
      const records = buildRecords(
        powerStationOnly,
        powerStationCinemaName,
        powerStationPrefix,
      );
      const skippedPast = powerStationOnly.length - records.length;
      const venueCtx: ImportRunContext = {
        ...ctx,
        cinemaName: powerStationCinemaName,
      };
      const { saved, errors } = await commitImport(
        venueCtx,
        records,
        nowUtc,
      );
      totalSaved += saved;
      allErrors.push(...errors);
      venueResults.push({
        cinema_name: powerStationCinemaName,
        prefix: powerStationPrefix,
        found: powerStationOnly.length,
        saved,
        skipped_past: skippedPast,
      });
    }

    const archesPresentOnPage =
      archesOnly.length > 0 ||
      powerStationDiagnostics.archesBookingButtons > 0 ||
      powerStationDiagnostics.venueHeadingsArches > 0;

    if (archesPresentOnPage) {
      const records = buildRecords(
        archesOnly,
        archesCinemaName,
        archesPrefix,
      );
      const skippedPast = archesOnly.length - records.length;
      const venueCtx: ImportRunContext = {
        ...ctx,
        cinemaName: archesCinemaName,
      };
      const { saved, errors } = await commitImport(
        venueCtx,
        records,
        nowUtc,
      );
      totalSaved += saved;
      allErrors.push(...errors);
      venueResults.push({
        cinema_name: archesCinemaName,
        prefix: archesPrefix,
        found: archesOnly.length,
        saved,
        skipped_past: skippedPast,
      });
    } else {
      console.log(
        "[import-olympic-cinemas] Arches not present on page; skipping commit to preserve existing rows.",
      );
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
    const message = `Import errors: ${allErrors.join("; ")}`;
    await endRun(ctx, runId, "failed", totalSaved, totalSaved, message);
    return jsonResponse(
      {
        success: false,
        error: message,
        screenings_saved: totalSaved,
      },
      500,
    );
  }

  await endRun(ctx, runId, "success", totalSaved, totalSaved);
  console.log(`[import-olympic-cinemas] done: total saved=${totalSaved}`);

  const allRecords: ScreeningRecord[] = [];
  for (const venueResult of venueResults) {
    const { data } = await supabase
      .from("screenings")
      .select(
        "cinema_name,movie_title,start_time,booking_url,format,sold_out,availability_status,projection_formats,accessibility_features,programme_types,screening_label,screening_tags,source_reference",
      )
      .eq("cinema_name", venueResult.cinema_name)
      .eq("active", true)
      .order("start_time", { ascending: true })
      .limit(5);

    if (data) allRecords.push(...(data as ScreeningRecord[]));
  }

  const examples: Record<string, ScreeningRecord[]> = {};
  for (const venueResult of venueResults) {
    examples[venueResult.cinema_name] = allRecords
      .filter((record) => record.cinema_name === venueResult.cinema_name)
      .slice(0, 5);
  }

  return jsonResponse({
    success: true,
    venues: venueResults.map((venueResult) => ({
      cinema_name: venueResult.cinema_name,
      screenings_found: venueResult.found,
      screenings_saved: venueResult.saved,
      skipped_past: venueResult.skipped_past,
    })),
    diagnostics: powerStationDiagnostics,
    total_screenings_saved: totalSaved,
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
    examples,
  });
});
