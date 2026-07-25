import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonOffsetMinutes,
  londonToUtc,
  inferYear,
  decodeEntities,
  stripTags,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";

const HOMEPAGE_URL = "https://www.davidleancinema.uk/";
const CINEMA_NAME = "David Lean Cinema";
const SOURCE_PREFIX = "davidlean";
const MIN_SCREENINGS = 1;
const BASE_URL = "https://www.davidleancinema.uk";

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9,
  oct: 10, nov: 11, dec: 12,
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

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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

// Parse a time string like "7.30pm" or "2.00pm" → { hour, minute } 24h.
function parseDotTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().toLowerCase().match(/^(\d{1,2})\.(\d{2})\s*(am|pm)$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3];
  if (ampm === "am" && hour === 12) hour = 0;
  if (ampm === "pm" && hour !== 12) hour += 12;
  return { hour, minute };
}

// Parse a time string like "7:30pm" or "7.30pm" → { hour, minute } 24h.
function parseTime(t: string): { hour: number; minute: number } | null {
  return parseDotTime(t) || parseColonTime(t);
}

function parseColonTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3];
  if (ampm === "am" && hour === 12) hour = 0;
  if (ampm === "pm" && hour !== 12) hour += 12;
  return { hour, minute };
}

// Find film/event page links from the homepage.
// The homepage links to individual film pages like /backrooms-everything-must-go/
function extractFilmPageLinks(html: string): { url: string; slug: string }[] {
  const links: { url: string; slug: string }[] = [];
  const seen = new Set<string>();

  // Find all internal links that look like film/event pages.
  const linkRegex =
    /href="(https:\/\/www\.davidleancinema\.uk\/([a-z0-9-]+)\/?)"/g;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const url = m[1];
    const slug = m[2];
    // Skip non-film pages
    const skip = [
      "about-us", "agm-2026", "attendance-by-minors", "cinema-guidelines",
      "contact", "dlc-strategy", "policies", "refunds-and-exchange-policy",
      "volunteer-rotas", "volunteers", "feed", "xmlrpc-php",
      "joanna-scanlan-patron", "comments", "wp-content", "wp-includes",
      "wp-json", "files",
    ];
    if (skip.includes(slug) || slug.startsWith("wp-")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ url, slug });
  }
  return links;
}

// Parse a film/event page to extract screening dates, times, and booking links.
// Structure: <a class="et_pb_button" href="...">Get tickets for Tuesday 21 July at 7.30pm</a>
// Also: <a class="et_pb_button" href="...">Get Tickets for Saturday 25 July at 2.00pm (HOH)</a>
function parseFilmPage(
  html: string,
  slug: string,
  nowLondon: Date
): ParsedScreening[] {
  const results: ParsedScreening[] = [];

  // Extract the movie title from the first <h1> that contains text.
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  let movieTitle = slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  if (h1Match) {
    const h1Text = decodeEntities(stripTags(h1Match[1])).trim();
    if (h1Text) {
      // Remove BBFC rating prefix if present
      movieTitle = h1Text;
    }
  }

  // Find all "Get tickets" buttons.
  // Pattern: <a class="et_pb_button..." href="URL">Get [Tt]ickets for {Day} {Date} {Month} at {time}({label})</a>
  const buttonRegex =
    /<a[^>]*class="[^"]*et_pb_button[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = buttonRegex.exec(html)) !== null) {
    const bookingUrl = m[1];
    const buttonText = decodeEntities(stripTags(m[2])).trim();

    // Parse "Get tickets for Tuesday 21 July at 7.30pm" or
    // "Get Tickets for Saturday 25 July at 2.00pm (HOH)"
    const textMatch = buttonText.match(
      /(?:Get\s+)?[Tt]ickets?\s+for\s+(?:[A-Za-z]+\s+)?(\d{1,2})\s+([A-Za-z]+)\s+at\s+(\d{1,2}[.:]\d{2}\s*[ap]m)\s*(?:\(([^)]+)\))?/i
    );
    if (!textMatch) {
      // Not a screening button — skip (could be a donation link)
      continue;
    }

    const day = parseInt(textMatch[1], 10);
    const monthName = textMatch[2].toLowerCase();
    const month = MONTHS[monthName];
    if (!month) {
      results.push({
        movie_title: movieTitle,
        start_time_iso: null,
        booking_url: bookingUrl,
        performance_id: slug,
        format: textMatch[4] || null,
        sold_out: false,
        source_reference: "",
        parse_error: `Unknown month: "${textMatch[2]}"`,
      });
      continue;
    }

    const timeParts = parseTime(textMatch[3]);
    if (!timeParts) {
      results.push({
        movie_title: movieTitle,
        start_time_iso: null,
        booking_url: bookingUrl,
        performance_id: slug,
        format: textMatch[4] || null,
        sold_out: false,
        source_reference: "",
        parse_error: `Unparseable time: "${textMatch[3]}"`,
      });
      continue;
    }

    const year = inferYear(day, month, nowLondon);
    const utc = londonToUtc(year, month, day, timeParts.hour, timeParts.minute);

    // Build a stable source_reference from the booking URL or fallback.
    // Try to extract an ID from the booking URL (tinyurl doesn't have one,
    // but ticketsolve URLs might).
    const tsMatch = bookingUrl.match(/ticketsolve\.com\/.*\/([a-z0-9-]+)/i);
    const perfId = tsMatch ? tsMatch[1] : null;

    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const timeStr = `${String(timeParts.hour).padStart(2, "0")}${String(timeParts.minute).padStart(2, "0")}`;
    const sourceReference = perfId
      ? `${SOURCE_PREFIX}:${perfId}`
      : `${SOURCE_PREFIX}:${normaliseTitle(movieTitle)}:${dateStr}:${timeStr}`;

    results.push({
      movie_title: movieTitle,
      start_time_iso: utc.toISOString(),
      booking_url: bookingUrl,
      performance_id: perfId || slug,
      format: textMatch[4] || null,
      sold_out: false,
      source_reference: sourceReference,
    });
  }

  return results;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-david-lean] starting at ${startedIso}`);

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

  const ctx: ImportRunContext = {
    supabase,
    cinemaName: CINEMA_NAME,
    minScreenings: MIN_SCREENINGS,
    startedAt,
  };

  const runStart = await startRun(ctx);
  if (runStart.blocked) {
    return jsonResponse(
      {
        success: false,
        error: "Another import is already running for David Lean Cinema.",
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

  // 1. Fetch the homepage.
  let homepageHtml: string;
  try {
    const resp = await fetch(HOMEPAGE_URL, fetchOpts);
    if (!resp.ok) {
      const msg = `Failed to fetch homepage: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    homepageHtml = await resp.text();
    console.log(
      `[import-david-lean] homepage fetched ${homepageHtml.length} bytes`
    );
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  const nowUtc = new Date();
  const offsetMin = londonOffsetMinutes(nowUtc);
  const nowLondon = new Date(nowUtc.getTime() + offsetMin * 60 * 1000);

  // 2. Extract film page links from the homepage.
  const filmLinks = extractFilmPageLinks(homepageHtml);
  console.log(
    `[import-david-lean] found ${filmLinks.length} film page links`
  );

  // 3. Fetch each film page and parse screenings.
  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  try {
    for (const { url, slug } of filmLinks) {
      let filmHtml: string;
      try {
        const resp = await fetch(url, fetchOpts);
        if (!resp.ok) {
          console.warn(
            `[import-david-lean] film page ${url} returned HTTP ${resp.status}`
          );
          continue;
        }
        filmHtml = await resp.text();
      } catch (err) {
        console.warn(
          `[import-david-lean] failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }

      const screenings = parseFilmPage(filmHtml, slug, nowLondon);
      parsed.push(...screenings);

      // Be gentle between pages.
      await new Promise((r) => setTimeout(r, 50));
    }
    parseErrors = parsed
      .filter((p) => p.parse_error)
      .map((p) => p.parse_error as string);
    console.log(
      `[import-david-lean] parsed ${parsed.length} screenings, ${parseErrors.length} errors`
    );
  } catch (err) {
    const msg = `Parse error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 500);
  }

  if (parsed.length < MIN_SCREENINGS) {
    const msg = `Unusually low screening count (${parsed.length}). Database left untouched.`;
    await endRun(ctx, runId, "failed", parsed.length, 0, msg);
    return jsonResponse(
      { success: false, error: msg, screenings_found: parsed.length },
      500
    );
  }

  const upcoming = parsed.filter(
    (p) =>
      p.start_time_iso !== null &&
      new Date(p.start_time_iso).getTime() > nowUtc.getTime()
  );
  const skippedPast = parsed.length - upcoming.length;
  console.log(
    `[import-david-lean] ${upcoming.length} upcoming, ${skippedPast} past skipped`
  );

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
      {
        success: false,
        error: msg,
        screenings_found: parsed.length,
        screenings_saved: saved,
      },
      500
    );
  }

  await endRun(ctx, runId, "success", parsed.length, saved);
  console.log(
    `[import-david-lean] done: found=${parsed.length} saved=${saved}`
  );

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    screenings_found: parsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    film_pages_fetched: filmLinks.length,
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
