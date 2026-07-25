import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonOffsetMinutes,
  londonToUtc,
  decodeEntities,
  stripTags,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";

const CINELUMIERE_URL = "https://cinelumiere.savoysystems.co.uk/CineLumiere.dll/";
const CINEMA_NAME = "Ciné Lumière";
const SOURCE_PREFIX = "cinelumiere";
const MIN_SCREENINGS = 3;

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

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Parse a Savoy date heading like "Saturday 3 Oct 2026" → { day, month, year }.
function parseSavoyDate(text: string): { day: number; month: number; year: number } | null {
  const m = text.trim().match(
    /^(?:[A-Za-z]+)\s+(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/
  );
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthName = m[2].toLowerCase();
  const year = parseInt(m[3], 10);
  const month = MONTHS[monthName];
  if (!month) return null;
  return { day, month, year };
}

// Parse a 24h time like "18:15" → { hour, minute }.
function parse24hTime(t: string): { hour: number; minute: number } | null {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
}

// Parse the Savoy Systems programme HTML.
// Structure per film:
//   <h2 class="subtitle first"><a href="...TcsProgramme_{progId}">Title</a> (Cert.X)</h2>
//   <div class="eightcol showtimes last">
//     <table><tr><td><table>
//       <tr>
//         <td class="PeformanceListDate">Saturday 3 Oct 2026</td>
//         <td class="PeformanceListTimes"><span class="StartTimeAndStatus">
//           <a class="Button" href="...TcsPerformance_{perfId}...">18:15</a>
//         </span></td>
//       </tr>
//     </table></td></tr></table>
//   </div>
function parseCineLumiere(html: string): ParsedScreening[] {
  const results: ParsedScreening[] = [];

  // Split into programme blocks by the subtitle heading.
  const blockRegex =
    /<h2 class="subtitle first"><a href="[^"]*TcsProgramme_(\d+)"[^>]*>([\s\S]*?)<\/a>\s*\(([^)]*)\)<\/h2>\s*<div class="eightcol showtimes last">([\s\S]*?)(?=<h2 class="subtitle first"|<div class="clearfix"><\/div><div class="programmetype|<div class="footer|$)/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const progId = blockMatch[1];
    const rawTitle = blockMatch[2];
    const cert = blockMatch[3].trim();
    const showtimesBody = blockMatch[4];

    const movieTitle = decodeEntities(stripTags(rawTitle)).trim();
    if (!movieTitle) continue;

    // Each row: <td class="PeformanceListDate">Date</td> ... <td class="PeformanceListTimes">...<a href="...TcsPerformance_{id}...">Time</a>...</td>
    // A date may have multiple times following it.
    const rowRegex =
      /<td class="PeformanceListDate">([^<]+)<\/td>[\s\S]*?<td class="PeformanceListTimes">([\s\S]*?)<\/td>/g;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRegex.exec(showtimesBody)) !== null) {
      const dateText = rowMatch[1].trim();
      const timesBody = rowMatch[2];

      const dateParts = parseSavoyDate(dateText);
      if (!dateParts) {
        results.push({
          movie_title: movieTitle,
          start_time_iso: null,
          booking_url: "",
          performance_id: "",
          format: cert || null,
          sold_out: false,
          source_reference: "",
          parse_error: `Unparseable date: "${dateText}"`,
        });
        continue;
      }

      // Within timesBody, find all <a class="Button" href="...TcsPerformance_{id}...">Time</a>
      // If no anchor (sold out / closed), look for status text.
      const perfRegex =
        /<a class="Button" href="([^"]*TcsPerformance_(\d+)[^"]*)"[^>]*>([^<]+)<\/a>/g;
      let perfMatch: RegExpExecArray | null;
      let foundPerf = false;
      while ((perfMatch = perfRegex.exec(timesBody)) !== null) {
        foundPerf = true;
        const bookingUrl = perfMatch[1];
        const performanceId = perfMatch[2];
        const timeText = perfMatch[3].trim();

        const timeParts = parse24hTime(timeText);
        if (!timeParts) {
          results.push({
            movie_title: movieTitle,
            start_time_iso: null,
            booking_url: bookingUrl,
            performance_id: performanceId,
            format: cert || null,
            sold_out: false,
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
          format: cert || null,
          sold_out: false,
          source_reference: `${SOURCE_PREFIX}:${performanceId}`,
        });
      }

      // If no bookable performances found, check for closed/sold-out status.
      if (!foundPerf) {
        const statusMatch = timesBody.match(
          /class="PerformanceStatusSmall">([^<]+)<\/span>/
        );
        const statusText = statusMatch ? statusMatch[1].trim() : "";
        const closed = /closed for booking|sold out|unavailable/i.test(statusText);
        // Try to find a time text even in closed performances.
        const timeTextMatch = timesBody.match(/>\s*(\d{1,2}:\d{2})\s*</);
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
            // No performance ID available for closed bookings; use a fallback.
            const fallbackId = `${progId}-${dateParts.year}${String(dateParts.month).padStart(2, "0")}${String(dateParts.day).padStart(2, "0")}-${timeText.replace(":", "")}`;
            results.push({
              movie_title: movieTitle,
              start_time_iso: utc.toISOString(),
              booking_url: "",
              performance_id: fallbackId,
              format: cert || null,
              sold_out: closed,
              source_reference: `${SOURCE_PREFIX}:${fallbackId}`,
            });
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
  console.log(`[import-cine-lumiere] starting at ${startedIso}`);

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
      { success: false, error: "Another import is already running for Ciné Lumière.", blocked: true },
      409
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }
  const runId = runStart.runId;

  let html: string;
  try {
    const resp = await fetch(CINELUMIERE_URL, {
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
    console.log(`[import-cine-lumiere] fetched ${html.length} bytes`);
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  let parsed: ParsedScreening[] = [];
  let parseErrors: string[] = [];
  try {
    parsed = parseCineLumiere(html);
    parseErrors = parsed.filter((p) => p.parse_error).map((p) => p.parse_error as string);
    console.log(`[import-cine-lumiere] parsed ${parsed.length} screenings, ${parseErrors.length} errors`);
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
  console.log(`[import-cine-lumiere] ${upcoming.length} upcoming, ${skippedPast} past skipped`);

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
  console.log(`[import-cine-lumiere] done: found=${parsed.length} saved=${saved}`);

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
