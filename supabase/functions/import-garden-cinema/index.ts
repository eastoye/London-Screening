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

const PROGRAMME_URL = "https://www.thegardencinema.co.uk/";
const CINEMA_NAME = "The Garden Cinema";
const SOURCE_PREFIX = "garden";
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

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Parse a 24h time like "18:15" → { hour, minute }.
function parse24hTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

// Parse a Savoy date heading like "Monday 20 July" → { day, month }.
// Year is inferred from the current London date.
function parseGardenDate(
  text: string,
  nowLondon: Date
): { day: number; month: number; year: number } | null {
  const m = text
    .trim()
    .match(/^(?:[A-Za-z]+)\s+(\d{1,2})\s+([A-Za-z]+)$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const year = inferYear(day, month, nowLondon);
  return { day, month, year };
}

// Format tag mapping from CSS class names to human-readable labels.
const TAG_LABELS: Record<string, string> = {
  "ext-intro": "Intro",
  "ext-q_and_a": "Q&A",
  "ext-hoh": "HOH",
  "ext-pay_what_you_can": "Pay What You Can",
  "ext-live_music": "Live Music",
  "ext-discussion": "Discussion",
  "ext-members": "Members",
  "ext-audio_description": "Audio Description",
};

const fetchOpts: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  redirect: "follow" as const,
};

// Parse the Garden Cinema programme page.
// Structure:
//   <h2>Monday 20 July</h2>
//   <div class="films-list__by-date__film">
//     <h1 class="films-list__by-date__film__title"><a href="/film/{slug}">Title <span>U</span></a></h1>
//     <div class="films-list__by-date__film__stats">Director, Country, Year, Duration</div>
//     <div class="films-list__by-date__film__screeningtimes">
//       <div class="screening-panel">
//         <div class="screening-panel__date-title">Mon 20 Jul</div>
//         <span class="screening-time">
//           <a class="screening" href="...TcsPerformance_{id}...">18:00</a>
//         </span>
//         <span class="screening-tag ext-intro"></span>
//         <div class="screening-panel__footer-row">
//           <h4 data-name="..." data-datetime="Mon 20 Jul 20:00" data-id="...">
//             <span style="color:#C00;">SOLD OUT</span> – ...
//           </h4>
//         </div>
//       </div>
//     </div>
//   </div>
function parseGardenPage(
  html: string,
  nowLondon: Date
): ParsedScreening[] {
  const results: ParsedScreening[] = [];

  // Split by date headings (<h2>\n<span>Monday 20 July</span>\n</h2>).
  const headingRegex = /<h2[^>]*>\s*<span>((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}\s+[A-Za-z]+)<\/span>\s*<\/h2>/g;
  const headingPositions: { date: string; index: number }[] = [];
  let hm: RegExpExecArray | null;
  while ((hm = headingRegex.exec(html)) !== null) {
    headingPositions.push({ date: hm[1].trim(), index: hm.index });
  }

  for (let i = 0; i < headingPositions.length; i++) {
    const { date: dateText } = headingPositions[i];
    const blockStart = headingPositions[i].index;
    const blockEnd =
      i + 1 < headingPositions.length
        ? headingPositions[i + 1].index
        : html.length;
    const block = html.slice(blockStart, blockEnd);

    const dateParts = parseGardenDate(dateText, nowLondon);
    if (!dateParts) {
      results.push({
        movie_title: "",
        start_time_iso: null,
        booking_url: "",
        performance_id: "",
        format: null,
        sold_out: false,
        source_reference: "",
        parse_error: `Unparseable date heading: "${dateText}"`,
      });
      continue;
    }

    // Split block into film entries.
    const filmRegex =
      /<div class="films-list__by-date__film"[^>]*>([\s\S]*?)(?=<div class="films-list__by-date__film"|<\/div>\s*<\/div>\s*<h2|$)/g;
    let fm: RegExpExecArray | null;
    while ((fm = filmRegex.exec(block)) !== null) {
      const filmBody = fm[1];

      // Extract title from the film title heading.
      const titleMatch = filmBody.match(
        /<h1 class="films-list__by-date__film__title"><a[^>]*>([\s\S]*?)<\/a><\/h1>/
      );
      if (!titleMatch) continue;
      const movieTitle = decodeEntities(stripTags(titleMatch[1])).trim();
      if (!movieTitle) continue;

      // Extract release year from film stats (optional).
      const statsMatch = filmBody.match(
        /films-list__by-date__film__stats[^>]*>([\s\S]*?)<\/div>/
      );
      let releaseYear: string | null = null;
      if (statsMatch) {
        const statsText = stripTags(statsMatch[1]);
        const yearMatch = statsText.match(/(\d{4})/);
        if (yearMatch) releaseYear = yearMatch[1];
      }

      // Find all screening-panel opening tags and extract content between them.
      const panelStarts: { start: number; end: number }[] = [];
      const panelOpenRegex = /<div class="screening-panel[^"]*"[^>]*>/g;
      let poMatch: RegExpExecArray | null;
      while ((poMatch = panelOpenRegex.exec(filmBody)) !== null) {
        panelStarts.push({ start: poMatch.index, end: poMatch.index + poMatch[0].length });
      }

      for (let pi = 0; pi < panelStarts.length; pi++) {
        const panelContentStart = panelStarts[pi].end;
        const panelContentEnd =
          pi + 1 < panelStarts.length
            ? panelStarts[pi + 1].start
            : filmBody.length;
        const panelBody = filmBody.slice(panelContentStart, panelContentEnd);

        // Extract the time and booking link from the screening-time anchor.
        const screeningLinkMatch = panelBody.match(
          /<a class="screening[^"]*"\s+href="([^"]*TcsPerformance_(\d+)[^"]*)"[^>]*>([^<]+)<\/a>/
        );

        // Extract format tags from screening-tag spans.
        const tagMatches = panelBody.matchAll(
          /<span class="screening-tag\s+(ext-[\w_]+)"><\/span>/g
        );
        const tags: string[] = [];
        for (const tm of tagMatches) {
          const label = TAG_LABELS[tm[1]];
          if (label) tags.push(label);
        }

        // Check for sold-out status in the footer row.
        const soldOut = /SOLD\s*OUT/i.test(panelBody);

        if (screeningLinkMatch) {
          const bookingUrl = screeningLinkMatch[1];
          const performanceId = screeningLinkMatch[2];
          const timeText = screeningLinkMatch[3].trim();

          const timeParts = parse24hTime(timeText);
          if (!timeParts) {
            results.push({
              movie_title: movieTitle,
              start_time_iso: null,
              booking_url: bookingUrl,
              performance_id: performanceId,
              format: tags.length > 0 ? tags.join(", ") : null,
              sold_out: soldOut,
              source_reference: `${SOURCE_PREFIX}:${performanceId}`,
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

          results.push({
            movie_title: movieTitle,
            start_time_iso: utc.toISOString(),
            booking_url: bookingUrl,
            performance_id: performanceId,
            format: tags.length > 0 ? tags.join(", ") : null,
            sold_out: soldOut,
            source_reference: `${SOURCE_PREFIX}:${performanceId}`,
          });
        } else {
          // No booking link — might be sold out or closed.
          // Try to extract a time from the panel.
          const timeTextMatch = panelBody.match(
            /screening-time[^>]*>[\s\S]*?(\d{1,2}:\d{2})[\s\S]*?<\/span>/
          );
          const timeText = timeTextMatch ? timeTextMatch[1] : null;
          if (timeText) {
            const timeParts = parse24hTime(timeText);
            if (timeParts) {
              const utc = londonToUtc(
                dateParts.year,
                dateParts.month,
                dateParts.day,
                timeParts.hour,
                timeParts.minute
              );
              // Use a fallback ID since no performance ID is available.
              const dateStr = `${dateParts.year}-${String(dateParts.month).padStart(2, "0")}-${String(dateParts.day).padStart(2, "0")}`;
              const timeStr = `${String(timeParts.hour).padStart(2, "0")}${String(timeParts.minute).padStart(2, "0")}`;
              const fallbackId = `${normaliseTitle(movieTitle)}:${dateStr}:${timeStr}`;
              results.push({
                movie_title: movieTitle,
                start_time_iso: utc.toISOString(),
                booking_url: "",
                performance_id: fallbackId,
                format: tags.length > 0 ? tags.join(", ") : null,
                sold_out: true,
                source_reference: `${SOURCE_PREFIX}:${fallbackId}`,
              });
            }
          }
        }
      }
    }
  }

  return results;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-garden] starting at ${startedIso}`);

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
        error: "Another import is already running for The Garden Cinema.",
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

  let html: string;
  try {
    const resp = await fetch(PROGRAMME_URL, fetchOpts);
    if (!resp.ok) {
      const msg = `Failed to fetch programme: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    html = await resp.text();
    console.log(`[import-garden] fetched ${html.length} bytes`);
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  const nowUtc = new Date();
  const offsetMin = londonOffsetMinutes(nowUtc);
  const nowLondon = new Date(nowUtc.getTime() + offsetMin * 60 * 1000);

  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  try {
    parsed = parseGardenPage(html, nowLondon);
    parseErrors = parsed
      .filter((p) => p.parse_error)
      .map((p) => p.parse_error as string);
    console.log(
      `[import-garden] parsed ${parsed.length} screenings, ${parseErrors.length} errors`
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
    `[import-garden] ${upcoming.length} upcoming, ${skippedPast} past skipped`
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
  console.log(`[import-garden] done: found=${parsed.length} saved=${saved}`);

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
