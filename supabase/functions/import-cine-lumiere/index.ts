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
  screening_label?:string|null;
  accessibility_features?:Array<'relaxed'>;
  source_event_url?:string;
  availability_status?:"available"|"sold_out"|"unknown";
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
  sept: 9,
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
async function repairDateOverrides(html:string):Promise<string>{
  const pattern=/<tr><td class="PeformanceListDate">([^<]+)<\/td>[\s\S]*?<td class="PeformanceListTimes">([\s\S]*?)<\/td><\/tr>/g;
  const repairs=new Map<string,string>();
  for(const match of html.matchAll(pattern)){
    if(parseSavoyDate(match[1]))continue;
    // A separately ticketed workshop is not a film performance.
    const heading=html.slice(0,match.index).split('<h2 class="subtitle first">').pop()?.split('</h2>')[0]||'';
    if(/^Book your free ticket for the workshop$/i.test(match[1].trim())||/>Stop Motion Animation Workshop<\/a>/.test(heading)){repairs.set(match[0],'');continue;}
    const href=match[2].match(/href="([^"]*TcsPerformance_\d+[^\"]*)"/)?.[1];
    if(!href)throw new Error('Missing booking reference for date override');
    const response=await fetch(href,{signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error('Cannot resolve Savoy date override');
    const page=await response.text();
    const serial=page.match(/name="PerformanceStartDateTime" value="([\d.]+)"/)?.[1];
    if(!serial)throw new Error('Missing Savoy numeric performance date');
    // Savoy serial dates: epoch and fractional-day time checked against an
    // ordinary dated performance in this same live source.
    const local=new Date(Date.UTC(1899,11,30)+Math.round(Number(serial)*1440)*60000);
    if(local.getUTCFullYear()<2020||local.getUTCFullYear()>2100)throw new Error('Invalid Savoy serial date');
    const time=match[2].match(/>(\d{1,2}:\d{2})<\/a>/)?.[1];
    if(time!==String(local.getUTCHours()).padStart(2,'0')+':'+String(local.getUTCMinutes()).padStart(2,'0'))throw new Error('Savoy numeric date/time disagreement');
    const date=local.toLocaleDateString('en-GB',{timeZone:'UTC',weekday:'long',day:'numeric',month:'short',year:'numeric'}).replace(',','');
    repairs.set(match[0],match[0].replace(match[1],date));
  }
  for(const [before,after] of repairs)html=html.replace(before,after);
  return html;
}

function parseCineLumiere(html: string): ParsedScreening[] {
  const results: ParsedScreening[] = [];
  let expected=0;

  // Split into programme blocks by the subtitle heading.
  const blockRegex =
    /<h2 class="subtitle first"><a href="[^"]*TcsProgramme_(\d+)"[^>]*>([\s\S]*?)<\/a>\s*\(([^)]*)\)<\/h2>\s*<div class="eightcol showtimes last">([\s\S]*?)(?=<h2 class="subtitle first"|<div class="clearfix"><\/div><div class="programmetype|<div class="footer|$)/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const progId = blockMatch[1];
    const rawTitle = blockMatch[2];
    const cert = blockMatch[3].trim();
    const eventUrl=html.match(new RegExp('href="([^"]*TcsProgramme_'+progId+')"'))?.[1];
    const showtimesBody = blockMatch[4];

    const movieTitle = decodeEntities(stripTags(rawTitle)).trim();
    if (!movieTitle) continue;
    // Explicit non-film products in the same Savoy catalogue.
    if(movieTitle==='Language Activity'||movieTitle==='Stop Motion Animation Workshop')continue;
    expected += [...showtimesBody.matchAll(/href="[^"]*TcsPerformance_\d+[^"]*"/g)].length;

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
          format: null,
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
            format: null,
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
          source_event_url:eventUrl,availability_status:"available",
          screening_label:stripTags(timesBody.match(/class="PerformanceNotesSmall">([\s\S]*?)<\/span>/)?.[1]||'')||null,
          accessibility_features:/class="PerformanceNotesSmall">\s*\(Relaxed Screening\)/.test(timesBody)?['relaxed']:[],
          start_time_iso: utc.toISOString(),
          booking_url: bookingUrl,
          performance_id: performanceId,
          format: null,
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
        const closed = /sold out/i.test(statusText);
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
              source_event_url:eventUrl,availability_status:closed?"sold_out":"unknown",
              start_time_iso: utc.toISOString(),
              booking_url: "",
              performance_id: fallbackId,
              format: null,
              sold_out: closed,
              source_reference: `${SOURCE_PREFIX}:${fallbackId}`,
            });
          }
        }
      }
    }
  }

  if(results.some(r=>r.parse_error))throw new Error("Ciné Lumière contains unparseable dates or times: "+results.filter(r=>r.parse_error).map(r=>r.parse_error).slice(0,3).join('; '));
  const actual=results.filter(r=>r.booking_url).length;
  if(expected!==actual)throw new Error("Incomplete Ciné Lumière performance parsing: "+actual+" / "+expected+"; unmatched: "+[...html.matchAll(/href="[^"]*TcsPerformance_(\d+)[^"]*"/g)].map(m=>m[1]).filter(id=>!results.some(r=>r.performance_id===id)).slice(0,5).join(','));
  const unique=new Map<string,ParsedScreening>();
  for(const r of results){
    const old=unique.get(r.source_reference);
    if(old&&(old.movie_title!==r.movie_title||old.start_time_iso!==r.start_time_iso))throw new Error("Conflicting Ciné Lumière source reference");
    unique.set(r.source_reference,r);
  }
  return [...unique.values()];
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
      signal:AbortSignal.timeout(20000),
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
    parsed = parseCineLumiere(await repairDateOverrides(html));
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

  const {count:previous,error:countError}=await supabase.from("screenings").select("id",{count:"exact",head:true}).eq("cinema_name",CINEMA_NAME).eq("active",true).gt("start_time",nowUtc.toISOString());
  if(countError||upcoming.length<MIN_SCREENINGS||((previous??0)>=10&&upcoming.length<Math.ceil((previous??0)*0.5))){
    const error=countError?.message||"Suspicious Ciné Lumière count drop";
    await endRun(ctx,runId,"failed",parsed.length,0,error);
    return jsonResponse({success:false,error},500);
  }
  const records: ScreeningRecord[] = upcoming
    .filter((p) => p.start_time_iso !== null && p.source_reference)
    .map((p) => ({
      source_event_url:p.source_event_url,
      screening_label:p.screening_label??null,accessibility_features:p.accessibility_features??[],
      availability_status:p.sold_out?"sold_out":p.booking_url?"available":"unknown",
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
