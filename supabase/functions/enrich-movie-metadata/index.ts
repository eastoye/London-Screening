import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { selectMovieTrailer } from "./trailerSelection.js";

const TMDB_API = "https://api.themoviedb.org/3";
const BATCH_SIZE = 50;
const CONCURRENCY = 5;
const STALE_AFTER_DAYS = 30;
const RETRY_AFTER_HOURS = 24;
const VALID_CERTIFICATIONS = new Set(["U", "PG", "12", "12A", "15", "18", "R18"]);

type CertificationStatus = "confirmed" | "ambiguous" | "unavailable";
type MovieRow = {
  id: string;
  tmdb_id: number;
  uk_certification_status: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function selectUkCertification(releaseDates: unknown): {
  certification: string | null;
  status: CertificationStatus;
} {
  const countries = Array.isArray((releaseDates as { results?: unknown[] })?.results)
    ? (releaseDates as { results: Array<Record<string, unknown>> }).results
    : [];
  const gb = countries.find((entry) => entry.iso_3166_1 === "GB");
  const entries = Array.isArray(gb?.release_dates)
    ? (gb.release_dates as Array<Record<string, unknown>>)
    : [];

  const certificationsForType = (type: number) =>
    entries
      .filter((entry) => Number(entry.type) === type)
      .map((entry) => String(entry.certification || "").trim().toUpperCase())
      .filter(Boolean);

  const theatrical = certificationsForType(3);
  const candidates = theatrical.length > 0 ? theatrical : certificationsForType(2);
  const unique = [...new Set(candidates)];

  if (unique.length === 0) return { certification: null, status: "unavailable" };
  if (unique.length > 1) return { certification: null, status: "ambiguous" };
  if (!VALID_CERTIFICATIONS.has(unique[0])) {
    return { certification: null, status: "unavailable" };
  }
  return { certification: unique[0], status: "confirmed" };
}

async function fetchTmdbMovie(tmdbId: number, token: string) {
  const url = `${TMDB_API}/movie/${tmdbId}?language=en-GB&append_to_response=release_dates,videos&include_video_language=en-GB,en-US,null`;
  let response: Response | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (response.ok) return response.json();
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }

  throw new Error(`TMDB ${response?.status ?? "request failed"}`);
}

async function mapWithConcurrency<T>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<void>
) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await task(values[index]);
    }
  });
  await Promise.all(workers);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const tmdbToken = Deno.env.get("TMDB_READ_ACCESS_TOKEN");
  if (!supabaseUrl || !serviceRoleKey || !tmdbToken) {
    return json({ success: false, error: "Missing server credentials" }, 500);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_AFTER_DAYS * 86400000).toISOString();
  const retryBefore = new Date(now.getTime() - RETRY_AFTER_HOURS * 3600000).toISOString();

  const { data, error } = await db
    .from("movies")
    .select("id, tmdb_id, uk_certification_status")
    .eq("match_status", "matched")
    .not("tmdb_id", "is", null)
    .or(`movie_metadata_updated_at.is.null,movie_metadata_updated_at.lt.${staleBefore},trailer_checked_at.is.null,trailer_checked_at.lt.${staleBefore}`)
    .or(`movie_metadata_last_attempted_at.is.null,movie_metadata_last_attempted_at.lt.${retryBefore}`)
    .order("movie_metadata_updated_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE);

  if (error) return json({ success: false, error: error.message }, 500);

  const movies = (data || []) as MovieRow[];
  let enriched = 0;
  let failed = 0;
  let trailersChecked = 0;
  let trailersFound = 0;
  const errors: Array<{ tmdb_id: number; error: string }> = [];
  const trailerErrors: Array<{ tmdb_id: number; error: string }> = [];

  await mapWithConcurrency(movies, CONCURRENCY, async (movie) => {
    const attemptedAt = new Date().toISOString();
    try {
      const details = await fetchTmdbMovie(Number(movie.tmdb_id), tmdbToken);
      const genres = [...new Set(
        (Array.isArray(details.genres) ? details.genres : [])
          .map((genre: { name?: unknown }) => String(genre.name || "").trim())
          .filter(Boolean)
      )].sort((a, b) => a.localeCompare(b));
      const uk = selectUkCertification(details.release_dates);
      const { error: updateError } = await db
        .from("movies")
        .update({
          genres,
          uk_certification: uk.certification,
          uk_certification_status: uk.status,
          movie_metadata_updated_at: attemptedAt,
          movie_metadata_last_attempted_at: attemptedAt,
          movie_metadata_error: null,
        })
        .eq("id", movie.id);
      if (updateError) throw new Error(updateError.message);
      enriched += 1;

      // Trailer caching is independent of the existing genre/certification update.
      // An incomplete video payload leaves the previous cache in place for retry.
      if (Array.isArray(details.videos?.results)) {
        try {
          const key = selectMovieTrailer(details.videos.results);
          const { error: trailerError } = await db
            .from("movies")
            .update({
              trailer_youtube_key: key,
              trailer_tmdb_id: Number(movie.tmdb_id),
              trailer_checked_at: attemptedAt,
            })
            .eq("id", movie.id)
            .eq("tmdb_id", movie.tmdb_id)
            .eq("match_status", "matched");
          if (trailerError) throw new Error(trailerError.message);
          trailersChecked += 1;
          if (key) trailersFound += 1;
        } catch (error) {
          trailerErrors.push({
            tmdb_id: Number(movie.tmdb_id),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        trailerErrors.push({
          tmdb_id: Number(movie.tmdb_id),
          error: "TMDB video results unavailable",
        });
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ tmdb_id: Number(movie.tmdb_id), error: message });
      const failureUpdate: Record<string, unknown> = {
        movie_metadata_last_attempted_at: attemptedAt,
        movie_metadata_error: message.slice(0, 500),
      };
      if (["pending", "error"].includes(movie.uk_certification_status)) {
        failureUpdate.uk_certification_status = "error";
      }
      await db.from("movies").update(failureUpdate).eq("id", movie.id);
    }
  });

  return json({
    success: failed === 0,
    selected: movies.length,
    enriched,
    failed,
    errors: errors.slice(0, 10),
    trailersChecked,
    trailersFound,
    trailerErrors: trailerErrors.slice(0, 10),
  }, failed > 0 && enriched === 0 ? 502 : 200);
});
