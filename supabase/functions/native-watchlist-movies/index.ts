import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 10;

type JsonObject = Record<string, unknown>;

type TmdbMovie = {
  id?: unknown;
  title?: unknown;
  original_title?: unknown;
  release_date?: unknown;
  poster_path?: unknown;
  overview?: unknown;
};

type WatchlistRow = {
  user_id: string;
  tmdb_id: number;
  display_title: string;
  release_year: number | null;
  poster_path: string | null;
  added_at: string;
  metadata_updated_at: string;
};

class TmdbRequestError extends Error {
  status: number;

  constructor(status: number) {
    super(`TMDB request failed (${status}).`);
    this.name = "TmdbRequestError";
    this.status = status;
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
  Vary: "Origin",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function releaseYear(value: unknown): number | null {
  const match = String(value ?? "").match(/^(\d{4})-/);
  return match ? Number(match[1]) : null;
}

function posterPath(value: unknown): string | null {
  const path = cleanText(value, 300);
  return path.startsWith("/") ? path : null;
}

function mapCandidate(movie: TmdbMovie) {
  const tmdbId = positiveInteger(movie.id);
  const title = cleanText(movie.title, 500) || cleanText(movie.original_title, 500);

  if (!tmdbId || !title) return null;

  const originalTitle = cleanText(movie.original_title, 500);

  return {
    tmdbId,
    title,
    originalTitle: originalTitle && originalTitle !== title ? originalTitle : null,
    releaseYear: releaseYear(movie.release_date),
    posterPath: posterPath(movie.poster_path),
    overview: cleanText(movie.overview, 500),
  };
}

function mapWatchlistRow(row: WatchlistRow) {
  return {
    tmdbId: Number(row.tmdb_id),
    displayTitle: row.display_title,
    releaseYear: row.release_year,
    posterPath: row.poster_path,
    addedAt: row.added_at,
    metadataUpdatedAt: row.metadata_updated_at,
  };
}

async function tmdbGet(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${TMDB_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) throw new TmdbRequestError(response.status);
  return await response.json();
}

async function searchMovies(token: string, query: string) {
  const params = new URLSearchParams({
    query,
    include_adult: "false",
    language: "en-GB",
    region: "GB",
    page: "1",
  });
  const payload = (await tmdbGet(token, `/search/movie?${params}`)) as {
    results?: unknown;
  };
  const results = Array.isArray(payload?.results) ? payload.results : [];

  return results
    .map((movie) => mapCandidate(isObject(movie) ? movie : {}))
    .filter((movie) => movie !== null)
    .slice(0, MAX_RESULTS);
}

async function getMovie(token: string, tmdbId: number) {
  const movie = (await tmdbGet(
    token,
    `/movie/${tmdbId}?language=en-GB`,
  )) as TmdbMovie;
  const candidate = mapCandidate(movie);

  if (!candidate || candidate.tmdbId !== tmdbId) {
    throw new TmdbRequestError(404);
  }

  return candidate;
}

function tmdbFailure(error: unknown) {
  if (!(error instanceof TmdbRequestError)) {
    return json({ error: "TMDB could not be reached. Please try again." }, 502);
  }

  if (error.status === 404) {
    return json({ error: "That film could not be found on TMDB." }, 404);
  }

  if (error.status === 429) {
    return json(
      { error: "Movie search is temporarily busy. Please try again shortly." },
      429,
    );
  }

  return json({ error: "TMDB is temporarily unavailable. Please try again." }, 502);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  const tmdbToken = Deno.env.get("TMDB_READ_ACCESS_TOKEN")?.trim();

  if (!supabaseUrl || !anonKey || !serviceRoleKey || !tmdbToken) {
    console.error("[native-watchlist-movies] Missing server configuration.");
    return json({ error: "The native watchlist is not configured yet." }, 503);
  }

  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);

  if (!tokenMatch) {
    return json({ error: "Log in to use your watchlist." }, 401);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { Authorization: authorization },
    },
  });

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser(tokenMatch[1]);

  if (userError || !user) {
    return json({ error: "Your login has expired. Log in again." }, 401);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return json({ error: "The request body must be valid JSON." }, 400);
  }

  if (!isObject(body)) {
    return json({ error: "Invalid request body." }, 400);
  }

  if (body.action === "search") {
    const query = cleanText(body.query, MAX_QUERY_LENGTH);

    if (query.length < 2) {
      return json({ error: "Enter at least two characters to search." }, 400);
    }

    try {
      return json({ candidates: await searchMovies(tmdbToken, query) });
    } catch (error) {
      console.error(
        "[native-watchlist-movies] TMDB search failed:",
        error instanceof Error ? error.message : String(error),
      );
      return tmdbFailure(error);
    }
  }

  if (body.action !== "add") {
    return json({ error: 'Action must be either "search" or "add".' }, 400);
  }

  const tmdbId = positiveInteger(body.tmdbId);

  if (!tmdbId) {
    return json({ error: "A valid TMDB movie ID is required." }, 400);
  }

  let movie;

  try {
    movie = await getMovie(tmdbToken, tmdbId);
  } catch (error) {
    console.error(
      "[native-watchlist-movies] TMDB movie lookup failed:",
      error instanceof Error ? error.message : String(error),
    );
    return tmdbFailure(error);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  const now = new Date().toISOString();
  const row = {
    user_id: user.id,
    tmdb_id: movie.tmdbId,
    display_title: movie.title,
    release_year: movie.releaseYear,
    poster_path: movie.posterPath,
    metadata_updated_at: now,
  };

  const { data: inserted, error: insertError } = await admin
    .from("user_watchlist")
    .insert(row)
    .select(
      "user_id, tmdb_id, display_title, release_year, poster_path, added_at, metadata_updated_at",
    )
    .single();

  if (!insertError && inserted) {
    return json({ created: true, item: mapWatchlistRow(inserted as WatchlistRow) }, 201);
  }

  if (insertError?.code !== "23505") {
    console.error(
      "[native-watchlist-movies] Database insert failed:",
      insertError?.code ?? "unknown",
    );
    return json({ error: "The film could not be saved. Please try again." }, 500);
  }

  const { data: existing, error: updateError } = await admin
    .from("user_watchlist")
    .update({
      display_title: movie.title,
      release_year: movie.releaseYear,
      poster_path: movie.posterPath,
      metadata_updated_at: now,
    })
    .eq("user_id", user.id)
    .eq("tmdb_id", movie.tmdbId)
    .select(
      "user_id, tmdb_id, display_title, release_year, poster_path, added_at, metadata_updated_at",
    )
    .single();

  if (updateError || !existing) {
    console.error(
      "[native-watchlist-movies] Duplicate refresh failed:",
      updateError?.code ?? "unknown",
    );
    return json({ error: "The film could not be saved. Please try again." }, 500);
  }

  return json({ created: false, item: mapWatchlistRow(existing as WatchlistRow) });
});
