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

const BOOKING_NOW_URL = "https://www.arthousecrouchend.co.uk/booking-now/";
const CINEMA_NAME = "ArtHouse Crouch End";
const SOURCE_PREFIX = "arthouse";
const MIN_SCREENINGS = 3;

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

// Parse an ArtHouse programme date like "Fri 24 Jul" → { day, month } (year inferred).
function parseArtHouseDate(text: string, nowLondon: Date): { day: number; month: number; year: number } | null {
  const m = text.trim().match(/^[A-Za-z]{3}\s+(\d{1,2})\s+([A-Za-z]{3})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthName = m[2].toLowerCase();
  const month = MONTHS[monthName];
  if (!month) return null;
  const year = inferYear(day, month, nowLondon);
  return { day, month, year };
}

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Parse a programme page for one film.
// Structure:
//   <h1 class="prog-title">Title</h1>
//   ...
//   <div id="dates" class="day-Fri"><p class="bolder">Fri 24 Jul</p></div>
//   <div class="times">
//     <a href="...TcsPerformance_{perfId}" title="Click to Book"><span class="prog-times">{time}<span class="prog-notes">{notes}</span><small class="{status}"></small></span></a>
//   </div>
function parseProgrammePage(html: string, nowLondon: Date): ParsedScreening[] {
  const results: ParsedScreening[] = [];

  const titleMatch = html.match(/<h1 class="prog-title">([\s\S]*?)<\/h1>/);
  const movieTitle = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : "";
  if (!movieTitle) return results;

  // Extract format/type if present
  const typeMatch = html.match(/<span class="prog-type">([^<]+)<\/span>/);
  const progType = typeMatch ? stripTags(typeMatch[1]).trim() : null;

  // Find all date blocks followed by times blocks.
  // Pattern: <div id="dates" ...><p class="bolder">Date</p></div> ... <div class="times">...<a ...>...</a>...</div>
  const dateBlockRegex =
    /<div id="dates"[^>]*>\s*<p class="bolder">([^<]+)<\/p>\s*<\/div>\s*<div class="times">([\s\S]*?)<\/div>/g;
  let dateMatch: RegExpExecArray | null;
  while ((dateMatch = dateBlockRegex.exec(html)) !== null) {
    const dateText = dateMatch[1].trim();
    const timesBody = dateMatch[2];
    const dateParts = parseArtHouseDate(dateText, nowLondon);
    if (!dateParts) {
      results.push({
        movie_title: movieTitle,
        start_time_iso: null,
        booking_url: "",
        performance_id: "",
        format: progType,
        sold_out: false,
        source_reference: "",
        parse_error: `Unparseable date: "${dateText}"`,
      });
      continue;
    }

    // Each performance: <a href="...TcsPerformance_{id}" ...><span class="prog-times">{time}<span class="prog-notes">{notes}</span><small class="{status}"></small></span></a>
    const perfRegex =
      /<a href="([^"]*TcsPerformance_(\d+)[^"]*)"[^>]*><span class="prog-times">(\d{1,2}:\d{2})<span class="prog-notes">([^<]*)<\/span><small class="([^"]*)"><\/small><\/span><\/a>/g;
    let perfMatch: RegExpExecArray | null;
    while ((perfMatch = perfRegex.exec(timesBody)) !== null) {
      const bookingUrl = perfMatch[1];
      const performanceId = perfMatch[2];
      const timeText = perfMatch[3];
      const notes = perfMatch[4].trim();
      const statusClass = perfMatch[5];

      const timeParts = parse24hTime(timeText);
      if (!timeParts) {
        results.push({
          movie_title: movieTitle,
          start_time_iso: null,
          booking_url: bookingUrl,
          performance_id: performanceId,
          format: [progType, notes].filter(Boolean).join(", ") || null,
          sold_out: /soldout|sold out/i.test(statusClass),
          source_reference: `${SOURCE_PREFIX}:${performanceId}`,
          parse_error: `Unparseable time: "${timeText}"`,
        });
        continue;
      }
      const utc = londonToUtc(dateParts.year, dateParts.month, dateParts.day, timeParts.hour, timeParts.minute);
      results.push({
        movie_title: movieTitle,
        start_time_iso: utc.toISOString(),
        booking_url: bookingUrl,
        performance_id: performanceId,
        format: [progType, notes].filter(Boolean).join(", ") || null,
        sold_out: /soldout|sold out/i.test(statusClass),
        source_reference: `${SOURCE_PREFIX}:${performanceId}`,
      });
    }
  }

  return results;
}

// Discover programme page links from the booking-now page.
function discoverProgrammeLinks(html: string): { url: string; programmeId: string }[] {
  const links: { url: string; programmeId: string }[] = [];
  const seen = new Set<string>();
  const regex = /href="(\/programme\/\?programme_id=(\d+))"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const programmeId = m[2];
    if (seen.has(programmeId)) continue;
    seen.add(programmeId);
    links.push({ url: `https://www.arthousecrouchend.co.uk${m[1]}`, programmeId });
  }
  return links;
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-arthouse-crouch-end] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for ArtHouse Crouch End.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  // Step 1: fetch the booking-now page to discover programme links.
  let bookingNowHtml: string;
  try {
    bookingNowHtml = await fetchText(BOOKING_NOW_URL);
    console.log(`[import-arthouse-crouch-end] fetched booking-now ${bookingNowHtml.length}b`);
  } catch (err) {
    const msg = `Network error fetching booking-now: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  const programmeLinks = discoverProgrammeLinks(bookingNowHtml);
  console.log(`[import-arthouse-crouch-end] discovered ${programmeLinks.length} programme pages`);
  if (programmeLinks.length === 0) {
    const msg = "No programme links found on booking-now page.";
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  // Step 2: fetch each programme page and parse screenings.
  const nowLondon = nowInLondon();
  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  const fetchErrors: string[] = [];
  try {
    const pages = await Promise.all(programmeLinks.map((p) => fetchText(p.url).catch((e) => {
      fetchErrors.push(`${p.url}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    })));
    for (let i = 0; i < pages.length; i++) {
      const pageHtml = pages[i];
      if (!pageHtml) continue;
      const pageResults = parseProgrammePage(pageHtml, nowLondon);
      parsed = parsed.concat(pageResults);
    }
    parseErrors = parsed.filter((p) => p.parse_error).map((p) => p.parse_error as string);
    console.log(`[import-arthouse-crouch-end] parsed ${parsed.length} screenings, ${parseErrors.length} errors, ${fetchErrors.length} fetch errors`);
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
  console.log(`[import-arthouse-crouch-end] ${upcoming.length} upcoming, ${skippedPast} past skipped`);

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
  console.log(`[import-arthouse-crouch-end] done: found=${parsed.length} saved=${saved}`);

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    screenings_found: parsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    parse_errors: parseErrors.slice(0, 10),
    fetch_errors: fetchErrors.slice(0, 5),
    programme_pages_discovered: programmeLinks.length,
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
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
