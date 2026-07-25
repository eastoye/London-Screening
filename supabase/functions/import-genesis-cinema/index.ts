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

const GENESIS_URL = "https://www.genesiscinema.co.uk/whatson/all";
const CINEMA_NAME = "Genesis Cinema";
const SOURCE_PREFIX = "genesis";
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

// Parse a Genesis date heading like "Tuesday 21 July 2026" → { day, month, year }.
function parseGenesisDate(text: string): { day: number; month: number; year: number } | null {
  const m = text.trim().match(/^[A-Za-z]+\s+(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  if (!month) return null;
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

// Extract format/label tokens from a Genesis film title.
// Titles often prefix labels, e.g. "35mm - The Odyssey", "TFFF - Film Name".
function extractLabels(title: string): { cleanTitle: string; labels: string[] } {
  const labels: string[] = [];
  let clean = title;
  const labelPatterns: { regex: RegExp; label: string }[] = [
    { regex: /^35mm\s*[-:]\s*/i, label: "35mm" },
    { regex: /^Q&A\s*[-:]\s*/i, label: "Q&A" },
    { regex: /^subtitled\s*[-:]\s*/i, label: "Subtitled" },
    { regex: /^studio screening\s*[-:]\s*/i, label: "Studio Screening" },
    { regex: /^film festival\s*[-:]\s*/i, label: "Film Festival" },
    { regex: /^special event\s*[-:]\s*/i, label: "Special Event" },
    { regex: /^TFFF\s*[-:]\s*/i, label: "Film Festival" },
  ];
  for (const { regex, label } of labelPatterns) {
    if (regex.test(clean)) {
      labels.push(label);
      clean = clean.replace(regex, "");
    }
  }
  return { cleanTitle: clean.trim(), labels };
}

// Parse the Genesis "whatson/all" page.
// Structure per film:
//   <h1 class="pb-2"> <a href="/event/{eventId}">Title</a></h1>
//   ... <div>{Date}<div class="grid ...">
//     <a class="... perfButton ..." href="https://genesis.admit-one.co.uk/seats/?perfCode={perfCode}">...{time}...</a>
//     <a class="... soldOut" href="">{time}</a>   (sold out)
//   </div></div>
function parseGenesis(html: string, nowLondon: Date): ParsedScreening[] {
  const results: ParsedScreening[] = [];

  const filmRegex =
    /<h1 class="pb-2">\s*<a href="\/event\/(\d+)"[^>]*>([\s\S]*?)<\/a><\/h1>([\s\S]*?)(?=<h1 class="pb-2">|<footer|$)/g;
  let filmMatch: RegExpExecArray | null;
  while ((filmMatch = filmRegex.exec(html)) !== null) {
    const eventId = filmMatch[1];
    const rawTitle = stripTags(filmMatch[2]).trim();
    const body = filmMatch[3];
    if (!rawTitle) continue;

    const { cleanTitle, labels } = extractLabels(rawTitle);
    const movieTitle = cleanTitle || rawTitle;
    const formatLabel = labels.length > 0 ? labels.join(", ") : null;

    // The page renders showtimes twice: once in a desktop block
    // (<div class="hidden md:block">) and once in a mobile block
    // (<div class="block md:hidden">). Parse only the desktop block to
    // avoid duplicate source_references.
    const desktopMatch = body.match(/<div class="hidden md:block">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="col-span-10 block md:hidden">/);
    const desktopBody = desktopMatch ? desktopMatch[1] : body;

    // Each date block: <div>{Date text}<div class="grid ...">...</div></div>
    const dateBlockRegex = /<div>((?:Mon|Tues?|Wednes?|Thurs?|Fri|Satur?|Sun)day\s+\d{1,2}\s+[A-Za-z]+\s+\d{4})<div[^>]*>([\s\S]*?)<\/div><\/div>/g;
    let dateMatch: RegExpExecArray | null;
    while ((dateMatch = dateBlockRegex.exec(desktopBody)) !== null) {
      const dateText = dateMatch[1];
      const timesBody = dateMatch[2];

      const dateParts = parseGenesisDate(dateText);
      if (!dateParts) {
        results.push({
          movie_title: movieTitle,
          start_time_iso: null,
          booking_url: "",
          performance_id: "",
          format: formatLabel,
          sold_out: false,
          source_reference: "",
          parse_error: `Unparseable date: "${dateText}"`,
        });
        continue;
      }

      // Bookable performances: <a ... href="...perfCode={id}">...{time}...</a>
      const perfRegex =
        /href="https:\/\/genesis\.admit-one\.co\.uk\/seats\/\?perfCode=(\d+)"[^>]*>[\s\S]*?(\d{1,2}:\d{2})/g;
      let perfMatch: RegExpExecArray | null;
      while ((perfMatch = perfRegex.exec(timesBody)) !== null) {
        const perfCode = perfMatch[1];
        const timeText = perfMatch[2];
        const timeParts = parse24hTime(timeText);
        if (!timeParts) {
          results.push({
            movie_title: movieTitle,
            start_time_iso: null,
            booking_url: `https://genesis.admit-one.co.uk/seats/?perfCode=${perfCode}`,
            performance_id: perfCode,
            format: formatLabel,
            sold_out: false,
            source_reference: `${SOURCE_PREFIX}:${perfCode}`,
            parse_error: `Unparseable time: "${timeText}"`,
          });
          continue;
        }
        const utc = londonToUtc(dateParts.year, dateParts.month, dateParts.day, timeParts.hour, timeParts.minute);
        results.push({
          movie_title: movieTitle,
          start_time_iso: utc.toISOString(),
          booking_url: `https://genesis.admit-one.co.uk/seats/?perfCode=${perfCode}`,
          performance_id: perfCode,
          format: formatLabel,
          sold_out: false,
          source_reference: `${SOURCE_PREFIX}:${perfCode}`,
        });
      }

      // Sold-out performances: <a class="... soldOut" href="">{time}</a>
      const soldRegex = /soldOut"\s+href="">\s*(\d{1,2}:\d{2})/g;
      let soldMatch: RegExpExecArray | null;
      while ((soldMatch = soldRegex.exec(timesBody)) !== null) {
        const timeText = soldMatch[1];
        const timeParts = parse24hTime(timeText);
        if (!timeParts) continue;
        const utc = londonToUtc(dateParts.year, dateParts.month, dateParts.day, timeParts.hour, timeParts.minute);
        const fallbackId = `${normaliseTitle(movieTitle)}:${dateParts.year}-${String(dateParts.month).padStart(2, "0")}-${String(dateParts.day).padStart(2, "0")}:${timeText.replace(":", "")}`;
        results.push({
          movie_title: movieTitle,
          start_time_iso: utc.toISOString(),
          booking_url: "",
          performance_id: fallbackId,
          format: formatLabel,
          sold_out: true,
          source_reference: `${SOURCE_PREFIX}:${fallbackId}`,
        });
      }
    }
  }

  return results;
}

// Current date in Europe/London as a JS Date (wall-clock components read via London timezone).
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
  console.log(`[import-genesis-cinema] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for Genesis Cinema.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  let html: string;
  try {
    const resp = await fetch(GENESIS_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      const msg = `Failed to fetch programme: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    html = await resp.text();
    console.log(`[import-genesis-cinema] fetched ${html.length} bytes`);
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  try {
    parsed = parseGenesis(html, nowInLondon());
    parseErrors = parsed.filter((p) => p.parse_error).map((p) => p.parse_error as string);
    console.log(`[import-genesis-cinema] parsed ${parsed.length} screenings, ${parseErrors.length} errors`);
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
  console.log(`[import-genesis-cinema] ${upcoming.length} upcoming, ${skippedPast} past skipped`);

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
  console.log(`[import-genesis-cinema] done: found=${parsed.length} saved=${saved}`);

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    screenings_found: parsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    parse_errors: parseErrors.slice(0, 10),
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
