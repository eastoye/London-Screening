import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  jsonResponse,
  startRun,
  endRun,
  commitImport,
  type ScreeningRecord,
  type ImportRunContext,
} from "../_shared/importSafety.ts";
import {
  parsePrinceCharlesPage,
  type ParsedScreening,
} from "./parser.ts";

const PROGRAMME_URL = "https://princecharlescinema.com/whats-on/";
const CINEMA_NAME = "Prince Charles Cinema";
const MIN_SCREENINGS = 100;
const RATIO_GUARD_MIN_EXISTING = 100;
const MIN_EXPECTED_RATIO = 0.5;
const FETCH_TIMEOUT_MS = 30_000;

async function fetchProgramme(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(PROGRAMME_URL, {
      headers: {
        "User-Agent": "LondonScreenings/2.0 (+https://github.com/eastoye/London-Screening)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Programme fetch failed: HTTP ${response.status}`);
    const html = await response.text();
    if (
      html.length < 500_000 ||
      !html.includes("jacro-event movie-tabs row") ||
      !html.includes("performance-list-items")
    ) {
      throw new Error("Programme response was incomplete or no longer has the expected Jacro markup.");
    }
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

async function previousActiveCount(ctx: ImportRunContext, nowUtc: Date): Promise<number> {
  const { count, error } = await ctx.supabase.from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME)
    .eq("active", true)
    .gt("start_time", nowUtc.toISOString());
  if (error) throw new Error(`Could not read previous screening count: ${error.message}`);
  return count ?? 0;
}

function isNumericPccReference(value: string): boolean {
  return /^pcc:\d+$/.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

async function restoreKnownPerformanceReferences(
  ctx: ImportRunContext,
  screenings: ParsedScreening[],
): Promise<ParsedScreening[]> {
  const unresolved = screenings.filter(
    (screening) => screening.soldOut && !isNumericPccReference(screening.sourceReference),
  );
  if (!unresolved.length) return screenings;

  const startTimes = uniqueStrings(unresolved.map((screening) => screening.startTimeIso));
  const { data, error } = await ctx.supabase.from("screenings")
    .select("movie_title,start_time,source_reference,source_event_url")
    .eq("cinema_name", CINEMA_NAME)
    .in("start_time", startTimes);

  if (error) {
    throw new Error(`Could not read historical PCC performance references: ${error.message}`);
  }

  const historical = (data ?? [])
    .filter((row) =>
      typeof row.source_reference === "string" &&
      isNumericPccReference(row.source_reference)
    )
    .map((row) => ({
      movieTitle: String(row.movie_title ?? ""),
      startTimeIso: new Date(String(row.start_time)).toISOString(),
      sourceReference: String(row.source_reference),
      sourceEventUrl:
        typeof row.source_event_url === "string" ? row.source_event_url : null,
    }));

  return screenings.map((screening) => {
    if (!screening.soldOut || isNumericPccReference(screening.sourceReference)) {
      return screening;
    }

    const sameTime = historical.filter(
      (row) => row.startTimeIso === screening.startTimeIso,
    );

    const sameEvent = sameTime.filter(
      (row) =>
        row.sourceEventUrl !== null &&
        row.sourceEventUrl === screening.sourceEventUrl,
    );

    const candidateRows = sameEvent.length
      ? sameEvent
      : sameTime.filter((row) => row.movieTitle === screening.movieTitle);

    const candidateReferences = uniqueStrings(
      candidateRows.map((row) => row.sourceReference),
    );

    if (candidateReferences.length > 1) {
      throw new Error(
        `${screening.movieTitle} at ${screening.startTimeIso}: ` +
        `ambiguous historical PCC performance references (${candidateReferences.join(", ")})`,
      );
    }

    if (candidateReferences.length === 1) {
      return {
        ...screening,
        sourceReference: candidateReferences[0],
      };
    }

    // PCC sometimes removes the entire /booknow/<id> href from sold-out
    // markup. If this performance has never previously been seen with a
    // trustworthy numeric PCC reference, keep the deterministic fallback
    // rather than inventing an ID.
    return screening;
  });
}

function validateUnique(records: ScreeningRecord[]): string | null {
  const references = new Set<string>();
  const titleTimes = new Set<string>();
  for (const record of records) {
    if (references.has(record.source_reference)) {
      return `Duplicate source reference: ${record.source_reference}`;
    }
    references.add(record.source_reference);
    const titleTime = `${record.movie_title.toLowerCase()}|${record.start_time}`;
    if (titleTimes.has(titleTime)) {
      return `Duplicate title/time: ${record.movie_title} at ${record.start_time}`;
    }
    titleTimes.add(titleTime);
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startedAt = new Date();
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
      { success: false, blocked: true, error: "Import already running." },
      409,
    );
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse(
      { success: false, error: runStart.error ?? "Could not start run." },
      500,
    );
  }

  const runId = runStart.runId;
  let found = 0;

  try {
    const parsed = parsePrinceCharlesPage(await fetchProgramme(), startedAt);
    found = parsed.screenings.length;
    if (parsed.errors.length) {
      throw new Error(`Programme parse failed: ${parsed.errors.slice(0, 5).join(" | ")}`);
    }

    const resolvedScreenings = await restoreKnownPerformanceReferences(
      ctx,
      parsed.screenings,
    );

    const nowUtc = new Date();
    const future = resolvedScreenings.filter(
      (screening) => new Date(screening.startTimeIso).getTime() > nowUtc.getTime(),
    );

    if (future.length < MIN_SCREENINGS) {
      throw new Error(
        `Unusually low screening count (${future.length}); database left untouched.`,
      );
    }

    const previousCount = await previousActiveCount(ctx, nowUtc);
    if (
      previousCount >= RATIO_GUARD_MIN_EXISTING &&
      future.length < Math.ceil(previousCount * MIN_EXPECTED_RATIO)
    ) {
      throw new Error(
        `Count-drop guard blocked import: ${future.length} new future screenings vs ${previousCount} active.`,
      );
    }

    const records: ScreeningRecord[] = future.map((screening) => ({
      cinema_name: CINEMA_NAME,
      movie_title: screening.movieTitle,
      film_title_hint: screening.filmTitleHint,
      start_time: screening.startTimeIso,
      booking_url: screening.bookingUrl,
      format: screening.displayFormat,
      sold_out: screening.soldOut,
      projection_formats: screening.projectionFormats,
      accessibility_features: screening.accessibilityFeatures,
      programme_types: screening.programmeTypes,
      availability_status: screening.availabilityStatus,
      source_release_year: screening.sourceReleaseYear,
      source_runtime_minutes: screening.sourceRuntimeMinutes,
      source_directors: screening.sourceDirectors,
      source_countries: screening.sourceCountries,
      source_event_url: screening.sourceEventUrl,
      screen_name: null,
      screening_label: screening.screeningLabel,
      screening_tags: screening.screeningTags,
      verified_artwork_url: screening.artworkUrl,
      source_reference: screening.sourceReference,
      last_seen_at: startedAt.toISOString(),
    }));

    const duplicate = validateUnique(records);
    if (duplicate) throw new Error(duplicate);

    const result = await commitImport(ctx, records, nowUtc);
    if (result.errors.length) {
      throw new Error(`Import errors: ${result.errors.join("; ")}`);
    }

    await endRun(ctx, runId, "success", future.length, result.saved);
    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: future.length,
      screenings_saved: result.saved,
      previous_active: previousCount,
      excluded_non_film: parsed.excludedNonFilm,
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", found, 0, message);
    return jsonResponse(
      { success: false, cinema: CINEMA_NAME, error: message },
      500,
    );
  }
});
