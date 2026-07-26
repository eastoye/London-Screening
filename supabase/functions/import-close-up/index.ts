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

const LISTING_URL = "https://www.closeupfilmcentre.com/search_film_programmes/";
const CINEMA_NAME = "Close-Up Film Centre";
const SOURCE_PREFIX = "closeup";
const MIN_SCREENINGS = 3;
const BASE_URL = "https://www.closeupfilmcentre.com";

interface ParsedScreening {
  movie_title: string;
  start_time_iso: string | null;
  event_url: string;
  booking_url: string | null;
  format: string | null;
  sold_out: boolean;
  source_reference: string;
  parse_error?: string;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Parse a date heading like "Sunday 19 July 2026" → { day, month }.
// Year is inferred from the heading if present, otherwise from nowLondon.
function parseCloseUpDate(text: string): { day: number; month: number; year: number } | null {
  const m = text.trim().match(
    /^(?:[A-Za-z]+)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/
  );
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const year = parseInt(m[3], 10);
  return { day, month, year };
}

// Normalise a title for fallback source_reference.
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Parse the Close-Up listing page. The page contains a chronological list:
//   <h2>Sunday 19 July 2026</h2>
//   <a href=".../film_programmes/2026/.../mandy"><span>08:00 pm : Mandy</span></a><br/>
// Multiple screenings can share a date heading.
function parseListing(html: string, nowLondon: Date): ParsedScreening[] {
  const results: ParsedScreening[] = [];

  // Split by date headings.
  const headingRegex = /<h2>([^<]+)<\/h2>/g;
  const parts = html.split(headingRegex);
  // parts[0] = preamble, then alternating [date, body, date, body, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const dateText = parts[i].trim();
    const body = i + 1 < parts.length ? parts[i + 1] : "";

    const dateParts = parseCloseUpDate(dateText);
    if (!dateParts) continue;

    // Each screening: <a href="URL"><span>HH:MM pm : Title</span></a>
    const screeningRegex =
      /<a href="([^"]+)"[^>]*><span>\s*(\d{1,2}:\d{2}\s*[ap]m)\s*:\s*([^<]+)<\/span><\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = screeningRegex.exec(body)) !== null) {
      const eventUrl = m[1].startsWith("http") ? m[1] : `${BASE_URL}${m[1]}`;
      const timeText = m[2].trim();
      const movieTitle = m[3].trim();

      const timeParts = parse12hTime(timeText);
      if (!timeParts) {
        results.push({
          movie_title: movieTitle,
          start_time_iso: null,
          event_url: eventUrl,
          booking_url: null,
          format: null,
          sold_out: false,
          source_reference: "",
          parse_error: `Unparseable time: "${timeText}"`,
        });
        continue;
      }

      const utc = londonToUtc(
        dateParts.year,
        dateParts.month,
        dateParts.day,
        timeParts.hour,
        timeParts.minute
      );

      // Stable reference: use the last path segment of the event URL if unique,
      // otherwise normalised title + date + time.
      const slugMatch = eventUrl.match(/\/([^/]+)\/?$/);
      const slug = slugMatch ? slugMatch[1] : normaliseTitle(movieTitle);
      const dateStr = `${dateParts.year}-${String(dateParts.month).padStart(2, "0")}-${String(dateParts.day).padStart(2, "0")}`;
      const timeStr = `${String(timeParts.hour).padStart(2, "0")}${String(timeParts.minute).padStart(2, "0")}`;
      const sourceReference = `${SOURCE_PREFIX}:${slug}:${dateStr}:${timeStr}`;

      results.push({
        movie_title: movieTitle,
        start_time_iso: utc.toISOString(),
        event_url: eventUrl,
        booking_url: null,
        format: null,
        sold_out: false,
        source_reference: sourceReference,
      });
    }
  }

  return results;
}

// Fetch individual event pages to get booking URLs and format labels.
// The event page has a booking_calender table with rows containing
// title, date, time, and a "Book" link to ticketsource.
async function enrichWithEventPages(
  screenings: ParsedScreening[],
  fetchOpts: RequestInit
): Promise<{ enriched: ParsedScreening[]; errors: string[]; pagesFetched: number }> {
  const enriched: ParsedScreening[] = [];
  const errors: string[] = [];
  const eventUrls = new Map<string, ParsedScreening[]>();

  // Group screenings by event URL to fetch each page once.
  for (const s of screenings) {
    if (!s.event_url) continue;
    if (!eventUrls.has(s.event_url)) eventUrls.set(s.event_url, []);
    eventUrls.get(s.event_url)!.push(s);
  }

  let pagesFetched = 0;
  for (const [eventUrl, group] of eventUrls) {
    let eventHtml: string;
    try {
      const resp = await fetch(eventUrl, fetchOpts);
      if (!resp.ok) {
        errors.push(`${eventUrl}: HTTP ${resp.status}`);
        for (const s of group) enriched.push(s);
        continue;
      }
      eventHtml = await resp.text();
      pagesFetched++;
    } catch (err) {
      errors.push(`${eventUrl}: ${err instanceof Error ? err.message : String(err)}`);
      for (const s of group) enriched.push(s);
      continue;
    }

    // Parse the booking_calender table for booking URLs and format info.
    // Rows: <tr id="row"><td>Title</td><td>Date</td><td>Time</td><td>Book link</td></tr>
    const rowRegex =
      /<tr id="row">\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    const bookingInfo: { date: string; time: string; bookingUrl: string | null; soldOut: boolean }[] = [];
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRegex.exec(eventHtml)) !== null) {
      const dateText = rowMatch[2].trim();
      const timeText = rowMatch[3].trim();
      const bookCell = rowMatch[4];

      const bookLinkMatch = bookCell.match(/href="([^"]+)"/);
      const bookingUrl = bookLinkMatch ? bookLinkMatch[1] : null;
      const soldOut = /sold[- ]?out|fully booked|unavailable/i.test(bookCell) || !bookingUrl;

      bookingInfo.push({ date: dateText, time: timeText, bookingUrl, soldOut });
    }

    // Match booking info to screenings in this group by date+time.
    for (const s of group) {
      let matched = false;
      if (s.start_time_iso) {
        const d = new Date(s.start_time_iso);
        const londonDate = new Date(d.getTime() + londonOffsetMinutes(d) * 60 * 1000);
        const dayStr = String(londonDate.getUTCDate()).padStart(2, "0");
        const monthStr = String(londonDate.getUTCMonth() + 1).padStart(2, "0");
        const yearStr = londonDate.getUTCFullYear();
        // Close-Up dates are like "Monday 27.07.26" (DD.MM.YY)
        const datePattern = new RegExp(
          `${dayStr}\\.${monthStr}\\.${String(yearStr).slice(2)}|${dayStr}\\.${monthStr}\\.${yearStr}`
        );

        // Time: convert 24h to 12h for matching
        const hour = londonDate.getUTCHours();
        const minute = londonDate.getUTCMinutes();
        const time12h = `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;

        for (const bi of bookingInfo) {
          if (datePattern.test(bi.date) && bi.time.toLowerCase().includes(time12h.toLowerCase())) {
            s.booking_url = bi.bookingUrl;
            s.sold_out = bi.soldOut;
            matched = true;
            break;
          }
        }
      }
      enriched.push(s);
    }

    // Be gentle between pages.
    await new Promise((r) => setTimeout(r, 50));
  }

  return { enriched, errors, pagesFetched };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-close-up] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for Close-Up Film Centre.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  const fetchOpts: RequestInit = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    },
    redirect: "follow" as const,
  };

  // 1. Fetch the listing page.
  let listingHtml: string;
  try {
    const resp = await fetch(LISTING_URL, fetchOpts);
    if (!resp.ok) {
      const msg = `Failed to fetch listing: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    listingHtml = await resp.text();
    console.log(`[import-close-up] listing fetched ${listingHtml.length} bytes`);
  } catch (err) {
    const msg = `Network error fetching listing: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  // Current Europe/London time.
  const nowUtc = new Date();
  const offsetMin = londonOffsetMinutes(nowUtc);
  const nowLondon = new Date(nowUtc.getTime() + offsetMin * 60 * 1000);

  // 2. Parse the listing.
  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  try {
    parsed = parseListing(listingHtml, nowLondon);
    parseErrors = parsed.filter((p) => p.parse_error).map((p) => p.parse_error as string);
    console.log(`[import-close-up] parsed ${parsed.length} screenings from listing`);
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

  // 3. Enrich with event pages (booking URLs, sold-out status).
  const upcoming = parsed.filter(
    (p) => p.start_time_iso !== null && new Date(p.start_time_iso).getTime() > nowUtc.getTime()
  );
  const skippedPast = parsed.length - upcoming.length;
  console.log(`[import-close-up] ${upcoming.length} upcoming, ${skippedPast} past skipped`);

  const { enriched, errors: enrichErrors, pagesFetched } = await enrichWithEventPages(upcoming, fetchOpts);
  if (enrichErrors.length > 0) {
    console.warn(`[import-close-up] ${enrichErrors.length} event page fetch errors`);
    // Don't fail the whole import — we still have the listing data.
  }
  console.log(`[import-close-up] fetched ${pagesFetched} event pages for enrichment`);

  // 4. Build records.
  const records: ScreeningRecord[] = enriched
    .filter((p) => p.start_time_iso !== null && p.source_reference)
    .map((p) => ({
      cinema_name: CINEMA_NAME,
      movie_title: p.movie_title,
      start_time: p.start_time_iso as string,
      booking_url: p.booking_url ?? p.event_url,
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
  console.log(`[import-close-up] done: found=${parsed.length} saved=${saved}`);

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    screenings_found: parsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    event_pages_fetched: pagesFetched,
    parse_errors: parseErrors.slice(0, 10),
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
    examples: enriched.slice(0, 5).map((p) => ({
      movie_title: p.movie_title,
      start_time: p.start_time_iso,
      source_reference: p.source_reference,
      booking_url: p.booking_url ?? p.event_url,
      sold_out: p.sold_out,
    })),
  });
});
