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

const PROGRAMME_URL =
  "https://www.chiswickcinema.co.uk/full-programme-by-day/";
const CINEMA_NAME = "The Chiswick Cinema";
const SOURCE_PREFIX = "chiswick";
const MIN_SCREENINGS = 3;
const BASE_URL = "https://www.chiswickcinema.co.uk";

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

// Parse the "Full Programme by Day" page. This page lists films with their
// showtime links but does NOT include dates — the schedule covers the current
// week (Friday–Thursday). To get actual dates, we fetch each movie page which
// contains <h2><a href="...checkout/showing/{slug}/{id}">{Month} {Day}, {time}</a></h2>.
async function fetchMoviePages(
  programmeHtml: string,
  nowLondon: Date
): Promise<ParsedScreening[]> {
  const results: ParsedScreening[] = [];

  // Extract movie page links from the programme page.
  const movieLinkRegex =
    /<a href="(https:\/\/www\.chiswickcinema\.co\.uk\/movie\/[^"]+)">([^<]+)<\/a>/g;
  const movieLinks = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = movieLinkRegex.exec(programmeHtml)) !== null) {
    movieLinks.set(m[1], decodeEntities(m[2]).trim());
  }

  console.log(
    `[import-chiswick] found ${movieLinks.size} movie pages to fetch`
  );

  for (const [movieUrl, fallbackTitle] of movieLinks) {
    let movieHtml: string;
    try {
      const resp = await fetch(movieUrl, fetchOpts);
      if (!resp.ok) {
        console.warn(
          `[import-chiswick] movie page ${movieUrl} returned HTTP ${resp.status}`
        );
        continue;
      }
      movieHtml = await resp.text();
    } catch (err) {
      console.warn(
        `[import-chiswick] failed to fetch ${movieUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    // Extract the movie title from the page (first <h1> after "Showtimes").
    const titleMatch = movieHtml.match(
      /<h1[^>]*>([\s\S]*?)<\/h1>/
    );
    let movieTitle = fallbackTitle;
    if (titleMatch) {
      const h1Text = decodeEntities(stripTags(titleMatch[1])).trim();
      if (h1Text && h1Text !== "Showtimes") {
        movieTitle = h1Text;
      }
    }

    // Extract screenings: <h2><a href="...checkout/showing/{slug}/{id}">{Month} {Day}, {time}</a></h2>
    // Times are 12-hour format like "July 19, 11:20 am"
    const screeningRegex =
      /<a href="([^"]*checkout\/showing\/[^"]*\/(\d+))"[^>]*>([^<]+)<\/a>/g;
    let sm: RegExpExecArray | null;
    while ((sm = screeningRegex.exec(movieHtml)) !== null) {
      const bookingUrl = sm[1];
      const performanceId = sm[2];
      const text = decodeEntities(sm[3]).trim();

      // Parse "July 19, 11:20 am" or "July 19, 3:00 pm"
      const dateMatch = text.match(
        /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i
      );
      if (!dateMatch) {
        results.push({
          movie_title: movieTitle,
          start_time_iso: null,
          booking_url: bookingUrl,
          performance_id: performanceId,
          format: null,
          sold_out: false,
          source_reference: `${SOURCE_PREFIX}:${performanceId}`,
          parse_error: `Unparseable date/time: "${text}"`,
        });
        continue;
      }

      const monthName = dateMatch[1].toLowerCase();
      const month = MONTHS[monthName];
      if (!month) {
        results.push({
          movie_title: movieTitle,
          start_time_iso: null,
          booking_url: bookingUrl,
          performance_id: performanceId,
          format: null,
          sold_out: false,
          source_reference: `${SOURCE_PREFIX}:${performanceId}`,
          parse_error: `Unknown month: "${dateMatch[1]}"`,
        });
        continue;
      }

      const day = parseInt(dateMatch[2], 10);
      const hour = parseInt(dateMatch[3], 10);
      const minute = parseInt(dateMatch[4], 10);
      const ampm = dateMatch[5].toLowerCase();

      let h24 = hour;
      if (ampm === "am" && h24 === 12) h24 = 0;
      if (ampm === "pm" && h24 !== 12) h24 += 12;

      // Infer year from current London date.
      const year = inferYear(day, month, nowLondon);

      const utc = londonToUtc(year, month, day, h24, minute);

      results.push({
        movie_title: movieTitle,
        start_time_iso: utc.toISOString(),
        booking_url: bookingUrl,
        performance_id: performanceId,
        format: null,
        sold_out: false,
        source_reference: `${SOURCE_PREFIX}:${performanceId}`,
      });
    }

    // Be gentle between page fetches.
    await new Promise((r) => setTimeout(r, 50));
  }

  return results;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-chiswick] starting at ${startedIso}`);

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
        error: "Another import is already running for The Chiswick Cinema.",
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

  // 1. Fetch the programme page.
  let programmeHtml: string;
  try {
    const resp = await fetch(PROGRAMME_URL, fetchOpts);
    if (!resp.ok) {
      const msg = `Failed to fetch programme: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    programmeHtml = await resp.text();
    console.log(
      `[import-chiswick] programme fetched ${programmeHtml.length} bytes`
    );
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  const nowUtc = new Date();
  const offsetMin = londonOffsetMinutes(nowUtc);
  const nowLondon = new Date(nowUtc.getTime() + offsetMin * 60 * 1000);

  // 2. Parse by fetching individual movie pages.
  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  try {
    parsed = await fetchMoviePages(programmeHtml, nowLondon);
    parseErrors = parsed
      .filter((p) => p.parse_error)
      .map((p) => p.parse_error as string);
    console.log(
      `[import-chiswick] parsed ${parsed.length} screenings, ${parseErrors.length} errors`
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
    `[import-chiswick] ${upcoming.length} upcoming, ${skippedPast} past skipped`
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
  console.log(`[import-chiswick] done: found=${parsed.length} saved=${saved}`);

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    screenings_found: parsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    movie_pages_fetched: new Set(
      parsed.map((p) => p.movie_title)
    ).size,
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
