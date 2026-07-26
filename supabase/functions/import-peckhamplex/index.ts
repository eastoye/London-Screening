import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonToUtc,
  decodeEntities,
  stripTags,
  inferYear,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";

const LISTINGS_DAY_URL = "https://www.peckhamplex.london/api/v1/films/listings/days";
const HOH_URL = "https://www.peckhamplex.london/films/hard-of-hearing";
const AUTISM_URL = "https://www.peckhamplex.london/films/autism-friendly";
const WWB_URL = "https://www.peckhamplex.london/films/watch-with-baby";
const CINEMA_NAME = "Peckhamplex";
const SOURCE_PREFIX = "peckhamplex";
const MIN_SCREENINGS = 5;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

interface ParsedScreening {
  movie_title: string;
  start_time_iso: string | null;
  booking_url: string;
  performance_id: string;
  format: string | null;
  sold_out: boolean;
  source_reference: string;
  parse_error?: string;
}

function parse24hTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

// Parse a Peckhamplex day heading like "Tuesday 21st July 2026" → { day, month, year }.
function parsePeckDate(text: string, nowLondon: Date): { day: number; month: number; year: number } | null {
  const m = text.trim().match(/^[A-Za-z]+\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)(?:\s+(\d{4}))?$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthName = m[2].toLowerCase();
  const month = MONTHS[monthName];
  if (!month) return null;
  let year: number;
  if (m[3]) {
    year = parseInt(m[3], 10);
  } else {
    year = inferYear(day, month, nowLondon);
  }
  return { day, month, year };
}

// Normalise a title for fallback source references.
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Parse the by-day listings HTML fragment.
// Structure:
//   <h3>Tuesday 21st July 2026</h3>
//   <div class="film-day-wrapper">
//     <div class="film-title-wrapper">
//       <div class="title">Film Title</div>
//       <div class="times">
//         <a class="btn btn-info" href="https://ticketing.eu.veezi.com/purchase/{perfId}?...">18:00</a>
//         ...
//       </div>
//     </div>
//     ...
//   </div>
function parseByDay(html: string, nowLondon: Date, labelPerfIds: Map<string, string>): ParsedScreening[] {
  const results: ParsedScreening[] = [];

  const dayRegex = /<h3>([^<]+)<\/h3>([\s\S]*?)(?=<h3>|$)/g;
  let dayMatch: RegExpExecArray | null;
  while ((dayMatch = dayRegex.exec(html)) !== null) {
    const dateText = dayMatch[1].trim();
    const filmsBody = dayMatch[2];
    const dateParts = parsePeckDate(dateText, nowLondon);
    if (!dateParts) {
      results.push({
        movie_title: "",
        start_time_iso: null,
        booking_url: "",
        performance_id: "",
        format: null,
        sold_out: false,
        source_reference: "",
        parse_error: `Unparseable date: "${dateText}"`,
      });
      continue;
    }

    const filmRegex = /<div class="title">([^<]+)<\/div>([\s\S]*?)<div class="times">([\s\S]*?)<\/div>/g;
    let filmMatch: RegExpExecArray | null;
    while ((filmMatch = filmRegex.exec(filmsBody)) !== null) {
      const rawTitle = stripTags(filmMatch[1]).trim();
      const timesBody = filmMatch[3];
      if (!rawTitle) continue;
      const movieTitle = decodeEntities(rawTitle);

      const timeRegex = /<a class="btn btn-info"[^>]*href="(https:\/\/ticketing\.eu\.veezi\.com\/purchase\/(\d+)[^"]*)"[^>]*>([^<]+)<\/a>/g;
      let timeMatch: RegExpExecArray | null;
      while ((timeMatch = timeRegex.exec(timesBody)) !== null) {
        const bookingUrl = timeMatch[1];
        const perfId = timeMatch[2];
        const timeText = timeMatch[3].trim();
        const timeParts = parse24hTime(timeText);
        if (!timeParts) {
          results.push({
            movie_title: movieTitle,
            start_time_iso: null,
            booking_url: bookingUrl,
            performance_id: perfId,
            format: labelPerfIds.get(perfId) || null,
            sold_out: false,
            source_reference: `${SOURCE_PREFIX}:${perfId}`,
            parse_error: `Unparseable time: "${timeText}"`,
          });
          continue;
        }
        const utc = londonToUtc(dateParts.year, dateParts.month, dateParts.day, timeParts.hour, timeParts.minute);
        results.push({
          movie_title: movieTitle,
          start_time_iso: utc.toISOString(),
          booking_url: bookingUrl,
          performance_id: perfId,
          format: labelPerfIds.get(perfId) || null,
          sold_out: false,
          source_reference: `${SOURCE_PREFIX}:${perfId}`,
        });
      }
    }
  }

  return results;
}

// Parse the HOH page and return a set of performance IDs that are HOH subtitled.
function parseHoh(html: string): Set<string> {
  const ids = new Set<string>();
  const regex = /\/purchase\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

// Check the WWB page for any bookable screenings.
function parseWwb(html: string): { available: boolean; perfIds: string[] } {
  if (/no watch with baby screenings available/i.test(html) || /currently no/i.test(html)) {
    return { available: false, perfIds: [] };
  }
  const perfIds: string[] = [];
  const regex = /\/purchase\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    perfIds.push(m[1]);
  }
  return { available: perfIds.length > 0, perfIds };
}

// Current date in Europe/London as a JS Date (wall-clock components).
function nowInLondon(): Date {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "0", 10);
  return new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
  }
  return await resp.text();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-peckhamplex] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for Peckhamplex.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  let dayHtml: string;
  let hohHtml: string;
  let wwbHtml: string;
  let wwbAvailable = false;
  let wwbPerfIds: string[] = [];
  try {
    [dayHtml, hohHtml, wwbHtml] = await Promise.all([
      fetchText(LISTINGS_DAY_URL),
      fetchText(HOH_URL),
      fetchText(WWB_URL),
    ]);
    console.log(`[import-peckhamplex] fetched day=${dayHtml.length}b hoh=${hohHtml.length}b wwb=${wwbHtml.length}b`);
    const wwb = parseWwb(wwbHtml);
    wwbAvailable = wwb.available;
    wwbPerfIds = wwb.perfIds;
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  // Build a map of perfId → label from the HOH page.
  const hohIds = parseHoh(hohHtml);
  const labelPerfIds = new Map<string, string>();
  for (const id of hohIds) {
    labelPerfIds.set(id, "HOH Subtitled");
  }

  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  try {
    parsed = parseByDay(dayHtml, nowInLondon(), labelPerfIds);
    parseErrors = parsed.filter((p) => p.parse_error).map((p) => p.parse_error as string);
    console.log(`[import-peckhamplex] parsed ${parsed.length} screenings, ${parseErrors.length} errors`);
  } catch (err) {
    const msg = `Parse error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 500);
  }

  if (parsed.length < MIN_SCREENINGS) {
    const msg = `Unusually low screening count (${parsed.length}). Database left untouched.`;
    await endRun(ctx, runId, "failed", parsed.length, 0, msg);
    return jsonResponse({ success: false, error: msg, screenings_found: parsed.length }, 500);
  }

  const nowUtc = new Date();
  const upcoming = parsed.filter(
    (p) => p.start_time_iso !== null && new Date(p.start_time_iso).getTime() > nowUtc.getTime()
  );
  const skippedPast = parsed.length - upcoming.length;
  console.log(`[import-peckhamplex] ${upcoming.length} upcoming, ${skippedPast} past skipped`);

  const records: ScreeningRecord[] = upcoming
    .filter((p) => p.start_time_iso !== null && p.source_reference)
    .map((p) => ({
      cinema_name: CINEMA_NAME,
      movie_title: p.movie_title,
      start_time: p.start_time_iso as string,
      booking_url: p.booking_url || null,
      format: p.format,
      sold_out: p.sold_out,
      source_reference: p.source_reference,
      last_seen_at: new Date().toISOString(),
    }));

  const { saved, errors } = await commitImport(ctx, records, nowUtc);
  if (errors.length > 0) {
    const msg = `Import errors: ${errors.join("; ")}`;
    await endRun(ctx, runId, "failed", parsed.length, saved, msg);
    return jsonResponse(
      { success: false, error: msg, screenings_found: parsed.length, screenings_saved: saved },
      500
    );
  }

  await endRun(ctx, runId, "success", parsed.length, saved);
  console.log(`[import-peckhamplex] done: found=${parsed.length} saved=${saved}`);

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    screenings_found: parsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    parse_errors: parseErrors.slice(0, 10),
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
    coverage_notes: {
      watch_with_baby: wwbAvailable
        ? `${wwbPerfIds.length} Watch With Baby screening(s) found on separate page but NOT imported (excluded from standard programme per site policy).`
        : "No Watch With Baby screenings currently available on the WWB page. Standard programme imported without WWB coverage.",
    },
    examples: upcoming.slice(0, 5).map((p) => ({
      movie_title: p.movie_title,
      start_time: p.start_time_iso,
      source_reference: p.source_reference,
      booking_url: p.booking_url || null,
      format: p.format,
      sold_out: p.sold_out,
    })),
  });
});
