import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  londonToUtc,
  stripTags,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  normaliseProjectionFormats,
  normaliseScreeningTags,
  type AccessibilityFeature,
  type AvailabilityStatus,
  type ProgrammeType,
  type ProjectionFormat,
} from "../_shared/screeningMetadata.ts";

const CALENDAR_URL = "https://castlesidcup.com/calendar/film/";
const SITE_ORIGIN = "https://castlesidcup.com";
const CINEMA_NAME = "Castle Sidcup";
const SOURCE_PREFIX = "castle-sidcup";
const MIN_SCREENINGS = 5;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;

type ParsedScreening = {
  source_event_url:string|null;
  verified_artwork_url:string|null;
  source_release_year:number|null;
  source_runtime_minutes:number|null;
  source_directors:string[];
  screen_name:string|null;
  screening_label:string|null;
  screening_tags:ReturnType<typeof normaliseScreeningTags>;
  movie_title: string;
  start_time_iso: string;
  booking_url: string | null;
  source_reference: string;
  sold_out: boolean;
  projection_formats: ProjectionFormat[];
  accessibility_features: AccessibilityFeature[];
  programme_types: ProgrammeType[];
  availability_status: AvailabilityStatus;
  display_format: string | null;
};

const fetchOpts: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
  },
  redirect: "follow",
};

function absoluteUrl(href: string | null): string | null {
  if (!href) return null;
  try {
    return new URL(href, SITE_ORIGIN).toString();
  } catch {
    return null;
  }
}

function parseLocalStart(raw: string): string | null {
  const dt = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!dt) return null;

  const utc = londonToUtc(
    Number(dt[1]),
    Number(dt[2]),
    Number(dt[3]),
    Number(dt[4]),
    Number(dt[5]),
  );
  utc.setUTCSeconds(Number(dt[6] || "0"));
  return utc.toISOString();
}

function metadataFromPerformance(explicit: string) {
  const projection_formats = normaliseProjectionFormats([explicit]);
  const accessibility_features: AccessibilityFeature[] = [];
  const programme_types: ProgrammeType[] = [];

  if (/\b(?:HOH\s*subtitles?|captioned|closed\s*captioned)\b/i.test(explicit)) {
    accessibility_features.push("captioned");
  }
  if (/\b(?:audio\s*described|audio\s*description|\bAD\b)\b/i.test(explicit)) {
    accessibility_features.push("audio_described");
  }
  if (/\brelaxed\b/i.test(explicit)) {
    accessibility_features.push("relaxed");
  }
  if (/\bparent\s*(?:&|and)\s*baby\b/i.test(explicit)) {
    programme_types.push("parent_and_baby");
  }
  if (/\bsilver\s*screening\b/i.test(explicit)) {
    programme_types.push("seniors");
  }
  if (/\bmembers?\s*only\b/i.test(explicit)) {
    programme_types.push("members_only");
  }

  return { projection_formats, accessibility_features, programme_types };
}

function parseCastleSidcup(html: string): ParsedScreening[] {
  const results: ParsedScreening[] = [];
  const seen = new Set<string>();
  let parsedMarkers=0;

  const tileRegex =
    /<div class="programme-tile tile[^"]*"[^>]*data-prog-id="(\d+)"[^>]*>([\s\S]*?)(?=<div class="programme-tile tile|<h3 class="date"|$)/g;

  let tileMatch: RegExpExecArray | null;
  while ((tileMatch = tileRegex.exec(html)) !== null) {
    const tileBody = tileMatch[2];

    const titleMatch = tileBody.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
    if (!titleMatch) continue;

    const movieTitle = stripTags(titleMatch[1]);
    if (!movieTitle) continue;

    const programmeHref =
      tileBody.match(
        /href=["'](\/programme\/\d+\/[a-z0-9-]+\/?)["']/i,
      )?.[1] ?? null;

    const programmeUrl = absoluteUrl(programmeHref);

    const perfRegex =
      /<a[^>]*class="performance-button[^"]*"[^>]*data-perf-id="(\d+)"[^>]*data-start-time="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

    let perfMatch: RegExpExecArray | null;
    while ((perfMatch = perfRegex.exec(tileBody)) !== null) {
      const perfId = perfMatch[1];
      const startTime = parseLocalStart(perfMatch[2]);
      if (!startTime) throw new Error("Invalid Sidcup performance date");
      parsedMarkers++;

      const source_reference = `${SOURCE_PREFIX}:performance:${perfId}`;
      if (seen.has(source_reference)) continue;
      seen.add(source_reference);

      const anchor = perfMatch[0];
      const perfBody = perfMatch[3];

      const soldOut = /\bis-sold-out\b/i.test(anchor.split(">")[0]);

      const href = anchor.match(/href=["']([^"']+)["']/i)?.[1] ?? null;
      const bookingUrl = absoluteUrl(href) ?? programmeUrl;

      const screeningType = perfBody.match(
        /<span class="screening-type">([\s\S]*?)<\/span>/i,
      )?.[1];

      const screenLabel = perfBody.match(
        /<span class="screen">([\s\S]*?)<\/span>/i,
      )?.[1];

      const explicitParts = [
        screeningType ? stripTags(screeningType) : "",
        ...[...anchor.matchAll(/(?:alt|title)=["']([^"']+)["']/gi)].map(
          (m) => m[1],
        ),
        stripTags(perfBody),
      ].filter(Boolean);

      const explicit = explicitParts.join(" ");
      const filters=anchor.match(/data-filters="([^"]*)"/)?.[1]?.split(",")||[];
      const metadata = metadataFromPerformance(screeningType?stripTags(screeningType):"");
      if(filters.includes("audio-described")&&!metadata.accessibility_features.includes("audio_described"))metadata.accessibility_features.push("audio_described");
      if(filters.includes("hard-of-hearing")&&!metadata.accessibility_features.includes("captioned"))metadata.accessibility_features.push("captioned");
      if(filters.includes("relaxed")&&!metadata.accessibility_features.includes("relaxed"))metadata.accessibility_features.push("relaxed");
      if(filters.includes("parent-baby")&&!metadata.programme_types.includes("parent_and_baby"))metadata.programme_types.push("parent_and_baby");

      const displayTags: string[] = [];
      const cleanedScreeningType = screeningType ? stripTags(screeningType) : "";
      if (cleanedScreeningType) displayTags.push(cleanedScreeningType);

      const cleanedScreen = screenLabel ? stripTags(screenLabel) : "";
      if (cleanedScreen) displayTags.push(cleanedScreen);

      const artwork=tileBody.match(/<img[^>]*class="film-poster"[^>]*src="([^"]+)"/)?.[1];
      results.push({
        source_event_url:programmeUrl,verified_artwork_url:absoluteUrl(artwork||null),
        source_release_year:null,source_runtime_minutes:null,source_directors:[],
        screen_name:cleanedScreen||null,screening_label:cleanedScreeningType||null,
        screening_tags:normaliseScreeningTags([cleanedScreeningType]),
        movie_title: movieTitle,
        start_time_iso: startTime,
        booking_url: bookingUrl,
        source_reference,
        sold_out: soldOut,
        projection_formats: metadata.projection_formats,
        accessibility_features: metadata.accessibility_features,
        programme_types: metadata.programme_types,
        availability_status: soldOut
          ? "sold_out"
          : bookingUrl && !/off-sale|inactive/.test(anchor.split(">")[0])
            ? "available"
            : "unknown",
        display_format:
          metadata.projection_formats.join(", ") || null,
      });
    }
  }

  if(parsedMarkers!==[...html.matchAll(/data-perf-id="\d+"/g)].length)throw new Error("Incomplete Sidcup calendar");
  return results;
}

async function getPreviousActiveCount(
  ctx: ImportRunContext,
  nowUtc: Date,
): Promise<number> {
  const { count, error } = await ctx.supabase
    .from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME)
    .eq("active", true)
    .gt("start_time", nowUtc.toISOString());

  if (error) {
    throw new Error(
      `Could not read previous screening count: ${error.message}`,
    );
  }

  return count ?? 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  const startedAt = new Date();
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { success: false, error: "Missing Supabase credentials." },
      500,
    );
  }

  const supabase = createClient(
    supabaseUrl,
    serviceRoleKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

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
        blocked: true,
        error: "Import already running.",
      },
      409,
    );
  }

  if (runStart.error || !runStart.runId) {
    return jsonResponse(
      {
        success: false,
        error:
          runStart.error ?? "Could not start run.",
      },
      500,
    );
  }

  const runId = runStart.runId;

  try {
    const response = await fetch(CALENDAR_URL, {...fetchOpts,signal:AbortSignal.timeout(20000)});

    if (!response.ok) {
      throw new Error(
        `Castle Sidcup film calendar returned HTTP ${response.status}`,
      );
    }

    const html = await response.text();

    if (
      !html.includes("programme-tile") ||
      !html.includes("performance-button")
    ) {
      throw new Error(
        "Castle Sidcup film calendar no longer contains the expected programme/performance markup.",
      );
    }

    const parsed = parseCastleSidcup(html);
    const nowUtc = new Date();

    const future = parsed
      .filter(
        (screening) =>
          new Date(screening.start_time_iso) > nowUtc,
      )
      .sort((a, b) =>
        a.start_time_iso.localeCompare(b.start_time_iso),
      );

    const previousCount =
      await getPreviousActiveCount(ctx, nowUtc);

    if (
      previousCount >= RATIO_GUARD_MIN_EXISTING &&
      future.length <
        Math.ceil(
          previousCount * MIN_EXPECTED_RATIO,
        )
    ) {
      throw new Error(
        `Count-drop guard blocked import: ${future.length} new future screenings vs ${previousCount} currently active.`,
      );
    }

    if (future.length < MIN_SCREENINGS) {
      throw new Error(
        `Unusually low screening count (${future.length}); database left untouched.`,
      );
    }

    const urls=[...new Set(future.map(r=>r.source_event_url).filter((u):u is string=>Boolean(u)))];
    for(let i=0;i<urls.length;i+=5)await Promise.all(urls.slice(i,i+5).map(async url=>{
      try{
        const response=await fetch(url,{...fetchOpts,signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw new Error(String(response.status));
        const page=await response.text();
        const runtime=page.match(/class="film-duration[^"]*"[^>]*>\s*(\d+)\s*mins/);
        const year=page.match(/class="film-year[^"]*"[^>]*>\s*((?:18|19|20|21)\d{2})\s*</);
        const director=page.match(/class="film-director"[^>]*>([\s\S]*?)<\/span>/);
        for(const r of future)if(r.source_event_url===url){
          r.source_runtime_minutes=runtime?Number(runtime[1]):null;
          r.source_release_year=year?Number(year[1]):null;
          r.source_directors=director?[stripTags(director[1])]:[];
        }
      }catch(error){console.warn("Optional Sidcup detail unavailable",url,String(error));}
    }));
    const records = future.map((screening) => ({
      source_event_url:screening.source_event_url,verified_artwork_url:screening.verified_artwork_url,
      source_runtime_minutes:screening.source_runtime_minutes,source_release_year:screening.source_release_year,source_directors:screening.source_directors,
      screen_name:screening.screen_name,screening_label:screening.screening_label,screening_tags:screening.screening_tags,
      cinema_name: CINEMA_NAME,
      movie_title: screening.movie_title,
      start_time: screening.start_time_iso,
      booking_url: screening.booking_url,
      format: screening.display_format,
      sold_out: screening.sold_out,
      source_reference: screening.source_reference,
      last_seen_at: new Date().toISOString(),
      projection_formats:
        screening.projection_formats,
      accessibility_features:
        screening.accessibility_features,
      programme_types:
        screening.programme_types,
      availability_status:
        screening.availability_status,
    })) as ScreeningRecord[];

    const { saved, errors } =
      await commitImport(ctx, records, nowUtc);

    if (errors.length > 0) {
      throw new Error(
        `Import errors: ${errors.join("; ")}`,
      );
    }

    await endRun(
      ctx,
      runId,
      "success",
      future.length,
      saved,
    );

    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      source: CALENDAR_URL,
      screenings_found: future.length,
      screenings_saved: saved,
      previous_active: previousCount,
      screenings: future.map((screening) => ({
        title: screening.movie_title,
        start_time: screening.start_time_iso,
        booking_url: screening.booking_url,
        sold_out: screening.sold_out,
        format: screening.display_format,
        projection_formats:
          screening.projection_formats,
        accessibility_features:
          screening.accessibility_features,
        programme_types:
          screening.programme_types,
        source_reference:
          screening.source_reference,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    await endRun(
      ctx,
      runId,
      "failed",
      0,
      0,
      message,
    );

    return jsonResponse(
      {
        success: false,
        cinema: CINEMA_NAME,
        error: message,
      },
      500,
    );
  }
});

