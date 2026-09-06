import {normaliseProjectionFormats,normaliseScreeningTags,type AccessibilityFeature,type ProgrammeType} from "../_shared/screeningMetadata.ts";
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

const CASTLE_URL = "https://thecastlecinema.com/calendar/";
const CINEMA_NAME = "The Castle Cinema";
const SOURCE_PREFIX = "castle";
const MIN_SCREENINGS = 5;

interface ParsedScreening {
  format: string | null;
  screen_name: string | null;
  screening_label: string | null;
  screening_tags: ReturnType<typeof normaliseScreeningTags>;
  accessibility_features: AccessibilityFeature[];
  programme_types: ProgrammeType[];
  availability_status: "sold_out" | "unknown" | "available";
  verified_artwork_url: string | null;
  source_runtime_minutes?: number | null;
  source_directors?: string[];
  movie_title: string;
  start_time_iso: string | null;
  perf_id: string;
  prog_id: string;
  screening_type: string | null;
  programme_url: string | null;
  booking_url: string | null;
  sold_out: boolean;
  source_reference: string;
}

// Parse the Castle Cinema calendar HTML. Each programme tile contains a
// data-prog-id and one or more performance-button anchors with data-perf-id,
// data-start-time, screening-type, screen, and sold-out status.
function parseCastle(html: string): ParsedScreening[] {
  const results: ParsedScreening[] = [];

  // Split into programme tiles. Each tile has data-prog-id and a film-times
  // block containing performance-button anchors.
  const tileRegex =
    /<div class="programme-tile tile[^"]*"[^>]*data-prog-id="(\d+)"[^>]*>([\s\S]*?)(?=<div class="programme-tile tile|<h3 class="date"|$)/g;
  let tileMatch: RegExpExecArray | null;
  while ((tileMatch = tileRegex.exec(html)) !== null) {
    const progId = tileMatch[1];
    const tileBody = tileMatch[2];

    // Movie title: first <h1> or <h2> in the tile.
    const titleMatch = tileBody.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/);
    if (!titleMatch) continue;
    const movieTitle = stripTags(titleMatch[1]);
    if (!movieTitle) continue;

    // Programme URL: href="/programme/{prog-id}/{slug}/"
    const progLinkMatch = tileBody.match(
      /href="(\/programme\/\d+\/[^"?#]+\/)"/i
    );
    const programmeUrl = progLinkMatch
      ? `https://thecastlecinema.com${progLinkMatch[1]}`
      : null;

    // Performance buttons.
    const perfRegex =
      /<a[^>]*class="performance-button[^"]*"[^>]*data-perf-id="(\d+)"[^>]*data-start-time="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let perfMatch: RegExpExecArray | null;
    while ((perfMatch = perfRegex.exec(tileBody)) !== null) {
      const perfId = perfMatch[1];
      const startTimeRaw = perfMatch[2];
      const perfBody = perfMatch[3];

      // Sold out: the anchor gets an "is-sold-out" (or "off-sale") class and the
      // sold-out span loses its display:none style. The span itself is always
      // present in the markup, so checking the span alone would mark everything
      // sold out — rely on the anchor class instead.
      const anchor=perfMatch[0].split(">")[0];
      const soldOut = /\bis-sold-out\b/.test(anchor);

      // Screening type / format.
      const stMatch = perfBody.match(
        /<span class="screening-type">([^<]+)<\/span>/
      );
      const screeningType = stMatch ? stMatch[1].trim() : null;

      // Screen label (S1, S2, etc.) — include in format if present alongside type.
      const screenMatch = perfBody.match(/<span class="screen">([^<]+)<\/span>/);
      const screenLabel = screenMatch ? screenMatch[1].trim() : null;

      let format: string | null = null;
      format = normaliseProjectionFormats([screeningType]).join(", ") || null;
      const filters=anchor.match(/data-filters="([^"]*)"/)?.[1]?.split(",")||[];
      const accessibility_features:AccessibilityFeature[]=[];
      if(filters.includes("audio-described"))accessibility_features.push("audio_described");
      if(filters.includes("hard-of-hearing"))accessibility_features.push("captioned");
      if(filters.includes("relaxed"))accessibility_features.push("relaxed");
      const programme_types:ProgrammeType[]=filters.includes("parent-baby")?["parent_and_baby"]:[];
      const image=tileBody.match(/<img[^>]*class="film-poster"[^>]*src="([^"]+)"/)?.[1];

      // Booking URL from href.
      const hrefMatch = perfMatch[0].match(/href="([^"]+)"/);
      const bookingUrl = hrefMatch
        ? hrefMatch[1].startsWith("http")
          ? hrefMatch[1]
          : `https://thecastlecinema.com${hrefMatch[1]}`
        : null;

      // data-start-time is local Europe/London time (no timezone in the string).
      // Convert to UTC.
      let startTimeIso: string | null = null;
      const dt = startTimeRaw.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
      );
      if (dt) {
        const year = parseInt(dt[1], 10);
        const month = parseInt(dt[2], 10);
        const day = parseInt(dt[3], 10);
        const hour = parseInt(dt[4], 10);
        const minute = parseInt(dt[5], 10);
        const second = parseInt(dt[6] || "0", 10);
        const utc = londonToUtc(year, month, day, hour, minute);
        utc.setUTCSeconds(second);
        startTimeIso = utc.toISOString();
      }

      if(!startTimeIso)throw new Error("Invalid Castle performance time");
      results.push({
        format,screen_name:screenLabel,screening_label:screeningType,
        screening_tags:normaliseScreeningTags([screeningType]),
        accessibility_features,programme_types,
        availability_status:soldOut?"sold_out":/\b(?:off-sale|inactive)\b/.test(anchor)?"unknown":bookingUrl?"available":"unknown",
        verified_artwork_url:image?new URL(decodeEntities(image),CASTLE_URL).href:null,
        movie_title: movieTitle,
        start_time_iso: startTimeIso,
        perf_id: perfId,
        prog_id: progId,
        screening_type: screeningType,
        programme_url: programmeUrl,
        booking_url: bookingUrl,
        sold_out: soldOut,
        source_reference: `${SOURCE_PREFIX}:${perfId}`,
      });
    }
  }

  const sourceCount=[...html.matchAll(/data-perf-id="\d+"/g)].length;
  if(results.length!==sourceCount)throw new Error("Castle calendar incomplete: unparsed performances");
  const unique=new Map<string,ParsedScreening>();
  for(const row of results){
    const old=unique.get(row.source_reference);
    if(old&&(old.movie_title!==row.movie_title||old.start_time_iso!==row.start_time_iso))throw new Error("Conflicting Castle performance ID");
    unique.set(row.source_reference,row);
  }
  return [...unique.values()];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
  const startedIso = startedAt.toISOString();
  console.log(`[import-castle-cinema] starting at ${startedIso}`);

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
        error: "Another import is already running for The Castle Cinema.",
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
    const resp = await fetch(CASTLE_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) {
      const msg = `Failed to fetch calendar: HTTP ${resp.status} ${resp.statusText}`;
      await endRun(ctx, runId, "failed", 0, 0, msg);
      return jsonResponse({ success: false, error: msg }, 502);
    }
    html = await resp.text();
    console.log(`[import-castle-cinema] fetched ${html.length} bytes`);
  } catch (err) {
    const msg = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    await endRun(ctx, runId, "failed", 0, 0, msg);
    return jsonResponse({ success: false, error: msg }, 502);
  }

  let parsed: ParsedScreening[] = [];
  try {
    parsed = parseCastle(html);
    console.log(`[import-castle-cinema] parsed ${parsed.length} screenings`);
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

  // Filter out past screenings.
  const nowUtc = new Date();
  const upcoming = parsed.filter(
    (p) => p.start_time_iso !== null && new Date(p.start_time_iso).getTime() > nowUtc.getTime()
  );
  const skippedPast = parsed.length - upcoming.length;
  console.log(
    `[import-castle-cinema] ${upcoming.length} upcoming, ${skippedPast} past skipped`
  );

  try{
    const {count:previous,error}=await supabase.from("screenings").select("id",{count:"exact",head:true}).eq("cinema_name",CINEMA_NAME).eq("active",true).gt("start_time",nowUtc.toISOString());
    if(error)throw error;
    if(upcoming.length<MIN_SCREENINGS||((previous??0)>=10&&upcoming.length<Math.ceil((previous??0)*0.5)))throw new Error("Suspicious Castle count drop");
    const urls=[...new Set(upcoming.map(p=>p.programme_url).filter((u):u is string=>Boolean(u)))];
    for(let i=0;i<urls.length;i+=5)await Promise.all(urls.slice(i,i+5).map(async url=>{
      try{
        const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error(String(response.status));
        const page=await response.text();
        const runtime=page.match(/class="film-duration[^"]*"[^>]*>\s*(\d+)\s*mins/);
        const director=page.match(/class="film-director"[^>]*>([\s\S]*?)<\/span>/);
        for(const row of upcoming)if(row.programme_url===url){
          if(runtime)row.source_runtime_minutes=Number(runtime[1]);
          if(director)row.source_directors=[stripTags(director[1])];
        }
      }catch(e){console.warn("Optional Castle detail unavailable",url,String(e));}
    }));
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    await endRun(ctx,runId,"failed",parsed.length,0,message);
    return jsonResponse({success:false,error:message},500);
  }

  // Build records. Use booking_url if available, otherwise programme_url.
  const records: ScreeningRecord[] = upcoming
    .filter((p) => p.start_time_iso !== null)
    .map((p) => ({
      cinema_name: CINEMA_NAME,
      movie_title: p.movie_title,
      start_time: p.start_time_iso as string,
      booking_url: p.booking_url ?? p.programme_url,
      format: p.format ?? null,
      sold_out: p.sold_out,
      source_event_url:p.programme_url,verified_artwork_url:p.verified_artwork_url,
      source_runtime_minutes:p.source_runtime_minutes??null,source_directors:p.source_directors??[],
      screen_name:p.screen_name,screening_label:p.screening_label,screening_tags:p.screening_tags,
      projection_formats:normaliseProjectionFormats([p.format]),
      accessibility_features:p.accessibility_features,programme_types:p.programme_types,availability_status:p.availability_status,
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
    `[import-castle-cinema] done: found=${parsed.length} saved=${saved}`
  );

  return jsonResponse({
    success: true,
    cinema: CINEMA_NAME,
    screenings_found: parsed.length,
    screenings_saved: saved,
    skipped_past: skippedPast,
    import_started_at: startedIso,
    import_completed_at: new Date().toISOString(),
    examples: upcoming.slice(0, 5).map((p) => ({
      movie_title: p.movie_title,
      start_time: p.start_time_iso,
      source_reference: p.source_reference,
      booking_url: p.booking_url ?? p.programme_url,
      format: p.screening_type,
      sold_out: p.sold_out,
    })),
  });
});
