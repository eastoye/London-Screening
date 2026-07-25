import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonOffsetMinutes,
  londonToUtc,
  parse12hTime,
  inferYear,
  decodeEntities,
  stripTags,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";

const WHATS_ON_URL = "https://www.actonecinema.co.uk/whats-on/";
const CINEMA_NAME = "ActOne Cinema";
const SOURCE_PREFIX = "actone";
const MIN_SCREENINGS = 5;
const BASE_URL = "https://www.actonecinema.co.uk";

interface ParsedScreening {
  movie_title: string;
  start_time_iso: string | null;
  booking_url: string;
  booking_id: string;
  source_reference: string;
  parse_error?: string;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Parse a date+time string like "July 19, 12:00 pm" → UTC Date.
function parseActOneDateTime(
  text: string,
  nowLondon: Date
): Date | null {
  const m = text.trim().match(
    /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i
  );
  if (!m) return null;
  const monthName = m[1].toLowerCase();
  const month = MONTHS[monthName];
  if (!month) return null;
  const day = parseInt(m[2], 10);
  const timeParts = parse12hTime(`${m[3]}:${m[4]} ${m[5]}`);
  if (!timeParts) return null;
  const year = inferYear(day, month, nowLondon);
  return londonToUtc(year, month, day, timeParts.hour, timeParts.minute);
}

// Extract the Movie title from schema.org JSON-LD or the page <h1>.
function extractTitle(html: string): string | null {
  // Try schema.org Movie JSON-LD first.
  const ldRegex =
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(ldMatch[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && item["@type"] === "Movie" && item.name) {
          return decodeEntities(item.name);
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  // Fallback: first <h1> after the hero / before Showtimes.
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  if (h1Match) {
    const t = stripTags(h1Match[1]);
    if (t && t.toLowerCase() !== "showtimes") return t;
  }
  return null;
}

// Parse the Showtimes section of a film page.
function parseShowtimes(
  html: string,
  nowLondon: Date
): ParsedScreening[] {
  const results: ParsedScreening[] = [];
  const title = extractTitle(html);
  if (!title) return results;

  // Find the Showtimes section.
  const showtimesIdx = html.indexOf("<h1>Showtimes</h1>");
  if (showtimesIdx === -1) return results;
  const section = html.slice(showtimesIdx);

  // Each showtime is <h2><a href=".../checkout/showing/{slug}/{id}">{date time}</a></h2>
  const showtimeRegex =
    /<a[^>]*href="([^"]*\/checkout\/showing\/[a-z0-9-]+\/(\d+))"[^>]*>([^<]+)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = showtimeRegex.exec(section)) !== null) {
    const bookingUrl = m[1];
    const bookingId = m[2];
    const dateTimeText = stripTags(m[3]);
    const utc = parseActOneDateTime(dateTimeText, nowLondon);
    results.push({
      movie_title: title,
      start_time_iso: utc ? utc.toISOString() : null,
      booking_url: bookingUrl,
      booking_id: bookingId,
      source_reference: `${SOURCE_PREFIX}:${bookingId}`,
      parse_error: utc ? undefined : `Unparseable datetime: "${dateTimeText}"`,
    });
  }

  return results;
}

// Discover all unique movie slugs from the whats-on page. Links appear as
// either relative ("/movie/{slug}") or absolute ("https://.../movie/{slug}").
function discoverMovieSlugs(html: string): string[] {
  const slugs = new Set<string>();
  const regex = /\/movie\/([a-z0-9-]+)\/?/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    slugs.add(m[1]);
  }
  return Array.from(slugs);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-actone-cinema] starting at ${startedIso}`);

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

  // Prevent overlapping runs.
  const runStart = await startRun(ctx);
  if (runStart.blocked) {
    return jsonResponse(
      {
        success: false,
        error: "Another import is already running for ActOne Cinema.",
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

  const fetchOpts = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    redirect: "follow" as const,
  };

  // 1. Fetch the whats-on page.
  let whatsOnHtml: string;
  try {
    const resp = await fetch(WHATS_ON_URL, fetchOpts);
    if (!resp.ok) {
      const msg = `Failed to fetch whats-on: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    whatsOnHtml = await resp.text();
    console.log(`[import-actone-cinema] whats-on fetched ${whatsOnHtml.length} bytes`);
  } catch (err) {
    const msg = `Network error fetching whats-on: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  // 2. Discover all unique movie slugs.
  const slugs = discoverMovieSlugs(whatsOnHtml);
  console.log(`[import-actone-cinema] discovered ${slugs.length} movie slugs`);
  if (slugs.length === 0) {
    const msg = "No movie slugs found on whats-on page.";
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  // Current Europe/London time for year inference.
  const nowUtc = new Date();
  const offsetMin = londonOffsetMinutes(nowUtc);
  const nowLondon = new Date(nowUtc.getTime() + offsetMin * 60 * 1000);

  // 3-5. Fetch each film page and parse showtimes.
  const allParsed: ParsedScreening[] = [];
  const parseErrors: string[] = [];
  let filmsProcessed = 0;
  let fetchFailures = 0;

  for (const slug of slugs) {
    const filmUrl = `${BASE_URL}/movie/${slug}/`;
    let filmHtml: string;
    try {
      const resp = await fetch(filmUrl, fetchOpts);
      if (!resp.ok) {
        console.warn(
          `[import-actone-cinema] film page ${slug} HTTP ${resp.status}`
        );
        fetchFailures++;
        continue;
      }
      filmHtml = await resp.text();
      filmsProcessed++;
    } catch (err) {
      console.warn(`[import-actone-cinema] film page ${slug} error:`, err);
      fetchFailures++;
      continue;
    }

    const parsed = parseShowtimes(filmHtml, nowLondon);
    for (const p of parsed) {
      if (p.parse_error) parseErrors.push(`${slug}: ${p.parse_error}`);
      allParsed.push(p);
    }
    // Be gentle.
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(
    `[import-actone-cinema] processed ${filmsProcessed}/${slugs.length} films, ${allParsed.length} screenings, ${fetchFailures} fetch failures`
  );

  // Safety: if too many film pages failed to fetch, the crawl is incomplete.
  // Don't deactivate existing screenings in that case.
  if (fetchFailures > slugs.length * 0.5) {
    const msg = `Too many film page fetch failures (${fetchFailures}/${slugs.length}). Crawl incomplete; database left untouched.`;
    await endRun(ctx, runId, "failed", allParsed.length, 0, msg);
    return jsonResponse(
      {
        success: false,
        error: msg,
        screenings_found: allParsed.length,
        films_processed: filmsProcessed,
        fetch_failures: fetchFailures,
      },
      502
    );
  }

  if (allParsed.length < MIN_SCREENINGS) {
    const msg = `Unusually low screening count (${allParsed.length}). Database left untouched.`;
    await endRun(ctx, runId, "failed", allParsed.length, 0, msg);
    return jsonResponse(
      { success: false, error: msg, screenings_found: allParsed.length },
      500
    );
  }

  // 6. Filter out past screenings.
  const upcoming = allParsed.filter(
    (p) => p.start_time_iso !== null && new Date(p.start_time_iso).getTime() > nowUtc.getTime()
  );
  const skippedPast = allParsed.length - upcoming.length;
  console.log(
    `[import-actone-cinema] ${upcoming.length} upcoming, ${skippedPast} past skipped`
  );

  // Build records.
  const records: ScreeningRecord[] = upcoming
    .filter((p) => p.start_time_iso !== null)
    .map((p) => ({
      cinema_name: CINEMA_NAME,
      movie_title: p.movie_title,
      start_time: p.start_time_iso as string,
      booking_url: p.booking_url,
      format: null,
      sold_out: false,
      source_reference: p.source_reference,
      last_seen_at: new Date().toISOString(),
    }));

  const { saved, errors } = await commitImport(ctx, records, nowUtc);
  if (errors.length > 0) {
    const msg = `Import errors: ${errors.join("; ")}`;
    await endRun(ctx, runId, "failed", allParsed.length, saved, msg);
    return jsonResponse(
      {
        success: false,
        error: msg,
        screenings_found: allParsed.length,
        screenings_saved: saved,
      },
      500
    );
  }

  await endRun(ctx, runId, "success", allParsed.length, saved);
  console.log(
    `[import-actone-cinema] done: found=${allParsed.length} saved=${saved}`
  );

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    films_discovered: slugs.length,
    films_processed: filmsProcessed,
    fetch_failures: fetchFailures,
    screenings_found: allParsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    parse_errors: parseErrors.slice(0, 10),
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
    examples: upcoming.slice(0, 5).map((p) => ({
      movie_title: p.movie_title,
      start_time: p.start_time_iso,
      source_reference: p.source_reference,
      booking_url: p.booking_url,
      booking_id: p.booking_id,
    })),
  });
});
