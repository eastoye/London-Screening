import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonToUtc,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";

const DATA_URL = "https://www.electriccinema.co.uk/data/data.json";
const BASE_URL = "https://www.electriccinema.co.uk";
const MIN_SCREENINGS = 3;

// Cinema IDs in the JSON data:
//   603 → Portobello
//   602 → White City
const CINEMA_MAP: Record<string, string> = {
  "603": "Electric Cinema Portobello",
  "602": "Electric Cinema White City",
};
const SOURCE_PREFIX_MAP: Record<string, string> = {
  "603": "electric:portobello",
  "602": "electric:white-city",
};

interface ElectricScreening {
  id: number;
  film: string;
  d: string;
  t: string;
  cinema: string;
  st: string;
  sn: string;
  r: string;
  bookable: boolean;
  link: string | false;
  message: string;
}

interface ElectricFilm {
  vistaId: string;
  title: string;
  link: string;
  rating: string;
  short_synopsis: string;
  premiere: string;
  director: string;
  screeningTypes: string[];
}

interface ElectricData {
  cinemas: Record<string, { id: number; title: string; url: string }>;
  films: Record<string, ElectricFilm>;
  screenings: Record<string, ElectricScreening>;
  screeningTypes: Record<string, { title: string }>;
}

const fetchOpts: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept: "application/json,text/html;q=0.9",
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
  console.log(`[import-electric] starting at ${startedIso}`);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { success: false, error: "Missing Supabase credentials." },
      500
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // We commit per venue, so we need separate run contexts.
  // But import_runs only allows one running row per cinema_name.
  // We'll use a single run under "Electric Cinemas" for locking, then
  // commit per venue with venue-specific contexts.
  const lockCtx: ImportRunContext = {
    supabase,
    cinemaName: "Electric Cinemas",
    minScreenings: MIN_SCREENINGS,
    startedAt,
  };

  const runStart = await startRun(lockCtx);
  if (runStart.blocked) {
    return jsonResponse(
      {
        success: false,
        error: "Another Electric Cinemas import is already running.",
        blocked: true,
      },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse(
      { success: false, error: runStart.error ?? "Could not start run." },
      500
    );
  }
  const runId = runStart.runId;

  // 1. Fetch the JSON data.
  let data: ElectricData;
  try {
    const resp = await fetch(`${DATA_URL}?a=${Date.now()}`, fetchOpts);
    if (!resp.ok) {
      const msg = `Failed to fetch data: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(lockCtx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    data = await resp.json();
    console.log(
      `[import-electric] fetched data: ${Object.keys(data.films).length} films, ${Object.keys(data.screenings).length} screenings`
    );
  } catch (err) {
    const msg = `Network/parse error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(lockCtx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  const nowUtc = new Date();

  // 2. Build records per venue.
  const recordsByVenue: Record<string, ScreeningRecord[]> = {
    "Electric Cinema Portobello": [],
    "Electric Cinema White City": [],
  };

  let totalFound = 0;
  for (const [sid, screening] of Object.entries(data.screenings)) {
    const cinemaName = CINEMA_MAP[screening.cinema];
    if (!cinemaName) continue;

    const film = data.films[screening.film];
    if (!film) continue;

    // Parse date "2026-07-19" and time "19:00"
    const dateParts = screening.d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeParts = screening.t.match(/^(\d{1,2}):(\d{2})$/);
    if (!dateParts || !timeParts) {
      console.warn(
        `[import-electric] unparseable date/time: ${screening.d} ${screening.t}`
      );
      continue;
    }

    const year = parseInt(dateParts[1], 10);
    const month = parseInt(dateParts[2], 10);
    const day = parseInt(dateParts[3], 10);
    const hour = parseInt(timeParts[1], 10);
    const minute = parseInt(timeParts[2], 10);

    const utc = londonToUtc(year, month, day, hour, minute);
    const startTime = utc.toISOString();

    // Skip past screenings
    if (utc.getTime() <= nowUtc.getTime()) {
      totalFound++;
      continue;
    }
    totalFound++;

    // Build booking URL
    const bookingUrl = screening.link
      ? screening.link.startsWith("http")
        ? screening.link
        : `${BASE_URL}${screening.link}`
      : null;

    // Format label from screening type
    let format: string | null = null;
    if (screening.st) {
      const stInfo = data.screeningTypes[screening.st];
      format = stInfo ? stInfo.title : screening.st;
    }

    const sourcePrefix = SOURCE_PREFIX_MAP[screening.cinema];
    const sourceReference = `${sourcePrefix}:${screening.id}`;

    const soldOut = !screening.bookable;

    recordsByVenue[cinemaName].push({
      cinema_name: cinemaName,
      movie_title: film.title,
      start_time: startTime,
      booking_url: bookingUrl,
      format,
      sold_out: soldOut,
      source_reference: sourceReference,
      last_seen_at: new Date().toISOString(),
    });
  }

  // 3. Validate minimum counts per venue.
  for (const [cinemaName, records] of Object.entries(recordsByVenue)) {
    if (records.length < MIN_SCREENINGS) {
      const msg = `${cinemaName} screening count too low (${records.length}). Database left untouched.`;
      await endRun(lockCtx, runId, "failed", totalFound, 0, msg);
      return jsonResponse(
        {
          success: false,
          error: msg,
          venue_counts: Object.fromEntries(
            Object.entries(recordsByVenue).map(([k, v]) => [k, v.length])
          ),
        },
        500
      );
    }
  }

  // 4. Commit each venue separately.
  const venueResults: {
    cinema_name: string;
    screenings_found: number;
    screenings_saved: number;
    skipped_past: number;
  }[] = [];
  let totalSaved = 0;
  const allErrors: string[] = [];

  for (const [cinemaName, records] of Object.entries(recordsByVenue)) {
    const venueCtx: ImportRunContext = {
      supabase,
      cinemaName,
      minScreenings: MIN_SCREENINGS,
      startedAt,
    };
    const { saved, errors } = await commitImport(venueCtx, records, nowUtc);
    totalSaved += saved;
    allErrors.push(...errors);
    venueResults.push({
      cinema_name: cinemaName,
      screenings_found: records.length,
      screenings_saved: saved,
      skipped_past: 0,
    });
  }

  if (allErrors.length > 0) {
    const msg = `Import errors: ${allErrors.join("; ")}`;
    await endRun(lockCtx, runId, "failed", totalFound, totalSaved, msg);
    return jsonResponse(
      {
        success: false,
        error: msg,
        screenings_found: totalFound,
        screenings_saved: totalSaved,
      },
      500
    );
  }

  await endRun(lockCtx, runId, "success", totalFound, totalSaved);
  console.log(`[import-electric] done: found=${totalFound} saved=${totalSaved}`);

  // Build examples per venue
  const examples: Record<string, ScreeningRecord[]> = {};
  for (const vr of venueResults) {
    examples[vr.cinema_name] = recordsByVenue[vr.cinema_name].slice(0, 5);
  }

  return jsonResponse({
    success: true,
    venues: venueResults,
    total_screenings_found: totalFound,
    total_screenings_saved: totalSaved,
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
    examples,
  });
});
