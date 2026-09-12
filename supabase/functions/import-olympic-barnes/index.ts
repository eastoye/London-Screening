import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  commitImport,
  corsHeaders,
  endRun,
  jsonResponse,
  londonOffsetMinutes,
  londonToUtc,
  startRun,
  type ImportRunContext,
  type ScreeningRecord,
} from "../_shared/importSafety.ts";
import {
  enrichScreening,
  parseFilmDetail,
  parseProgrammeListing,
  validateScreenings,
  type ExistingMetadata,
  type FilmDetail,
} from "./parser.ts";

const PROGRAMME_URL = "https://www.olympiccinema.com/whats-on";
const CINEMA_NAME = "Olympic Cinema Barnes";
const MIN_SCREENINGS = 3;
const RATIO_GUARD_MIN_EXISTING = 10;
const MIN_EXPECTED_RATIO = 0.5;
const FETCH_TIMEOUT_MS = 25_000;
const DETAIL_CONCURRENCY = 6;

const REQUEST_HEADERS = {
  "User-Agent": "LondonScreenings/2.0 (+https://github.com/eastoye/London-Screening)",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "en-GB,en;q=0.9",
};

async function fetchHtml(url: string, attempts = 1): Promise<string> {
  let finalError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: REQUEST_HEADERS,
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
      const html = await response.text();
      if (html.length < 10_000) throw new Error(`${url} was unexpectedly small (${html.length} bytes).`);
      return html;
    } catch (error) {
      finalError = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw finalError ?? new Error(`${url} could not be fetched.`);
}

async function previousActiveCount(ctx: ImportRunContext, now: Date): Promise<number> {
  const { count, error } = await ctx.supabase.from("screenings")
    .select("id", { count: "exact", head: true })
    .eq("cinema_name", CINEMA_NAME)
    .eq("active", true)
    .gt("start_time", now.toISOString());
  if (error) throw new Error(`Could not read previous Olympic Barnes count: ${error.message}`);
  return count ?? 0;
}

async function existingMetadata(
  ctx: ImportRunContext,
  references: string[],
): Promise<Map<string, ExistingMetadata>> {
  const output = new Map<string, ExistingMetadata>();
  for (let offset = 0; offset < references.length; offset += 200) {
    const batch = references.slice(offset, offset + 200);
    const { data, error } = await ctx.supabase.from("screenings")
      .select(
        "source_reference,movie_title,film_title_hint,source_release_year,source_runtime_minutes,source_directors,source_countries,source_event_url,screen_name,verified_artwork_url",
      )
      .eq("cinema_name", CINEMA_NAME)
      .in("source_reference", batch);
    if (error) throw new Error(`Could not read existing Olympic Barnes metadata: ${error.message}`);
    for (const row of data ?? []) {
      output.set(String(row.source_reference), {
        movieTitle: String(row.movie_title),
        filmTitleHint: typeof row.film_title_hint === "string" ? row.film_title_hint : null,
        sourceReleaseYear: typeof row.source_release_year === "number" ? row.source_release_year : null,
        sourceRuntimeMinutes: typeof row.source_runtime_minutes === "number" ? row.source_runtime_minutes : null,
        sourceDirectors: Array.isArray(row.source_directors) ? row.source_directors : [],
        sourceCountries: Array.isArray(row.source_countries) ? row.source_countries : [],
        sourceEventUrl: typeof row.source_event_url === "string" ? row.source_event_url : null,
        screenName: typeof row.screen_name === "string" ? row.screen_name : null,
        verifiedArtworkUrl: typeof row.verified_artwork_url === "string" ? row.verified_artwork_url : null,
      });
    }
  }
  return output;
}

async function fetchDetails(
  filmUrls: Map<string, string>,
): Promise<{ details: Map<string, FilmDetail>; failures: string[] }> {
  const entries = [...filmUrls.entries()];
  const details = new Map<string, FilmDetail>();
  const failures: string[] = [];
  for (let offset = 0; offset < entries.length; offset += DETAIL_CONCURRENCY) {
    const batch = entries.slice(offset, offset + DETAIL_CONCURRENCY);
    const settled = await Promise.all(batch.map(async ([slug, url]) => {
      try {
        return { slug, detail: parseFilmDetail(slug, await fetchHtml(url, 2)), error: null };
      } catch (error) {
        return {
          slug,
          detail: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    for (const result of settled) {
      if (result.detail) details.set(result.slug, result.detail);
      else failures.push(`${result.slug}: ${result.error}`);
    }
  }
  return { details, failures };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

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
    return jsonResponse({ success: false, blocked: true, error: "Import already running." }, 409);
  }
  if (runStart.error || !runStart.runId) {
    return jsonResponse({ success: false, error: runStart.error ?? "Could not start run." }, 500);
  }

  const runId = runStart.runId;
  let found = 0;
  try {
    const now = new Date();
    const londonOffset = londonOffsetMinutes(now);
    const nowLondon = new Date(now.getTime() + londonOffset * 60_000);
    const listing = parseProgrammeListing(await fetchHtml(PROGRAMME_URL, 2), now, nowLondon, londonToUtc);
    found = listing.screenings.length;
    if (listing.errors.length) {
      throw new Error(`Olympic Barnes source was incomplete: ${listing.errors.slice(0, 8).join(" | ")}`);
    }
    if (found < MIN_SCREENINGS) {
      throw new Error(`Unusually low Olympic Barnes screening count (${found}); database left untouched.`);
    }

    const references = listing.screenings.map((row) => row.sourceReference);
    const filmUrls = new Map(listing.screenings.map((row) => [row.filmSlug, row.filmUrl]));
    const [previousActive, existing, detailResult] = await Promise.all([
      previousActiveCount(ctx, now),
      existingMetadata(ctx, references),
      fetchDetails(filmUrls),
    ]);
    if (
      previousActive >= RATIO_GUARD_MIN_EXISTING &&
      found < Math.ceil(previousActive * MIN_EXPECTED_RATIO)
    ) {
      throw new Error(`Count-drop guard blocked import: ${found} new screenings vs ${previousActive} active.`);
    }

    const screenings = listing.screenings.map((row) => enrichScreening(
      row,
      detailResult.details.get(row.filmSlug) ?? null,
      existing.get(row.sourceReference) ?? null,
    ));
    const validationErrors = validateScreenings(screenings);
    if (validationErrors.length) {
      throw new Error(`Olympic Barnes validation failed: ${validationErrors.slice(0, 8).join(" | ")}`);
    }

    const records: ScreeningRecord[] = screenings.map((row) => ({
      cinema_name: CINEMA_NAME,
      movie_title: row.movieTitle,
      film_title_hint: row.filmTitleHint,
      start_time: row.startTimeIso,
      booking_url: row.bookingUrl,
      format: row.displayFormat,
      sold_out: row.soldOut,
      projection_formats: row.projectionFormats,
      accessibility_features: row.accessibilityFeatures,
      programme_types: row.programmeTypes,
      availability_status: row.availabilityStatus,
      source_release_year: row.sourceReleaseYear,
      source_runtime_minutes: row.sourceRuntimeMinutes,
      source_directors: row.sourceDirectors,
      source_countries: row.sourceCountries,
      source_event_url: row.sourceEventUrl,
      screen_name: row.screenName,
      screening_label: row.screeningLabel,
      screening_tags: row.screeningTags,
      verified_artwork_url: row.verifiedArtworkUrl,
      source_reference: row.sourceReference,
      last_seen_at: startedAt.toISOString(),
    }));

    const committed = await commitImport(ctx, records, now);
    if (committed.errors.length) throw new Error(`Import errors: ${committed.errors.join("; ")}`);
    await endRun(ctx, runId, "success", found, committed.saved);

    return jsonResponse({
      success: true,
      cinema: CINEMA_NAME,
      screenings_found: found,
      screenings_saved: committed.saved,
      previous_active: previousActive,
      date_sections: listing.dateSections,
      booking_buttons: listing.bookingButtons,
      detail_pages_requested: filmUrls.size,
      detail_pages_succeeded: detailResult.details.size,
      detail_page_failures: detailResult.failures,
      metadata: {
        title_hints: records.filter((row) => row.film_title_hint).length,
        release_years: records.filter((row) => row.source_release_year).length,
        runtimes: records.filter((row) => row.source_runtime_minutes).length,
        directors: records.filter((row) => row.source_directors?.length).length,
        countries: records.filter((row) => row.source_countries?.length).length,
        artwork: records.filter((row) => row.verified_artwork_url).length,
        projection_formats: records.filter((row) => row.projection_formats?.length).length,
        accessibility: records.filter((row) => row.accessibility_features?.length).length,
        programme_types: records.filter((row) => row.programme_types?.length).length,
        screening_tags: records.filter((row) => row.screening_tags?.length).length,
        available: records.filter((row) => row.availability_status === "available").length,
        sold_out: records.filter((row) => row.availability_status === "sold_out").length,
        unknown_availability: records.filter((row) => row.availability_status === "unknown").length,
      },
      examples: records.slice(0, 5),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await endRun(ctx, runId, "failed", found, 0, message);
    return jsonResponse({ success: false, cinema: CINEMA_NAME, error: message }, 500);
  }
});
