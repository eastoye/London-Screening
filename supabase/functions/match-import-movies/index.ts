import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TRAKT_API_BASE = "https://api.trakt.tv";
const MAX_RECORDS = 100;
const MAX_TITLE_LENGTH = 300;

type JsonObject = Record<string, unknown>;

type ImportRecord = {
  clientId: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  traktId: number | null;
};

type TmdbMovie = {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  poster_path?: string | null;
  overview?: string;
  popularity?: number;
};

type Candidate = {
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
  posterPath: string | null;
  overview: string;
  similarity: number;
  popularity: number;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredOrigins(): Set<string> {
  const redirects = [
    Deno.env.get("TRAKT_REDIRECT_URI") ?? "",
    ...(Deno.env.get("TRAKT_REDIRECT_URIS") ?? "").split(","),
  ];
  const origins = new Set<string>();

  for (const redirect of redirects.map((value) => value.trim()).filter(Boolean)) {
    try {
      origins.add(new URL(redirect).origin);
    } catch {
      // Invalid configured redirect values are ignored.
    }
  }

  return origins;
}

function responseHeaders(origin: string | null, allowed: Set<string>) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  };

  if (origin && allowed.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function validYear(value: unknown): number | null {
  const year = Number(value);
  const maximum = new Date().getUTCFullYear() + 3;
  return Number.isInteger(year) && year >= 1870 && year <= maximum ? year : null;
}

function imdbId(value: unknown): string | null {
  const match = String(value ?? "").match(/^tt\d{5,12}$/i);
  return match ? match[0].toLowerCase() : null;
}

function parseRecord(value: unknown): ImportRecord | null {
  if (!isObject(value)) return null;

  const clientId = typeof value.clientId === "string" ? value.clientId.slice(0, 100) : "";
  const title = typeof value.title === "string" ? value.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  const record = {
    clientId,
    title,
    year: validYear(value.year),
    imdbId: imdbId(value.imdbId),
    tmdbId: positiveInteger(value.tmdbId),
    traktId: positiveInteger(value.traktId),
  };

  return clientId && (title || record.imdbId || record.tmdbId || record.traktId)
    ? record
    : null;
}

function comparableTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(first: string, second: string): number {
  if (!first.length) return second.length;
  if (!second.length) return first.length;

  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  const current = new Array<number>(second.length + 1);

  for (let row = 1; row <= first.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= second.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1),
      );
    }
    for (let column = 0; column <= second.length; column += 1) {
      previous[column] = current[column];
    }
  }

  return previous[second.length];
}

function similarity(first: string, second: string): number {
  const left = comparableTitle(first);
  const right = comparableTitle(second);
  if (left === right) return 1;
  const length = Math.max(left.length, right.length);
  return length ? 1 - levenshtein(left, right) / length : 0;
}

function movieYear(movie: TmdbMovie): number | null {
  const match = String(movie.release_date ?? "").match(/^(\d{4})-/);
  return match ? Number(match[1]) : null;
}

function candidate(movie: TmdbMovie, query = ""): Candidate {
  const title = movie.title || movie.original_title || "Unknown title";
  const originalTitle = movie.original_title && movie.original_title !== title
    ? movie.original_title
    : null;
  const titleSimilarity = query
    ? Math.max(similarity(query, title), similarity(query, originalTitle || ""))
    : 1;

  return {
    tmdbId: movie.id,
    title,
    originalTitle,
    year: movieYear(movie),
    posterPath: movie.poster_path ?? null,
    overview: String(movie.overview || "").slice(0, 500),
    similarity: Math.round(titleSimilarity * 1000) / 1000,
    popularity: Number.isFinite(Number(movie.popularity)) ? Number(movie.popularity) : 0,
  };
}

async function tmdbGet(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${TMDB_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!response.ok) throw new Error(`TMDB request failed (${response.status}).`);
  return await response.json();
}

async function tmdbMovie(token: string, id: number): Promise<TmdbMovie | null> {
  try {
    return (await tmdbGet(token, `/movie/${id}?language=en-GB`)) as TmdbMovie;
  } catch {
    return null;
  }
}

async function findByImdb(token: string, id: string): Promise<TmdbMovie[]> {
  const params = new URLSearchParams({ external_source: "imdb_id", language: "en-GB" });
  const payload = (await tmdbGet(token, `/find/${encodeURIComponent(id)}?${params}`)) as {
    movie_results?: TmdbMovie[];
  };
  return payload.movie_results ?? [];
}

async function tmdbIdFromTrakt(traktClientId: string, id: number): Promise<number | null> {
  const response = await fetch(`${TRAKT_API_BASE}/search/trakt/${id}?type=movie`, {
    headers: {
      "trakt-api-version": "2",
      "trakt-api-key": traktClientId,
      Accept: "application/json",
    },
  });
  if (!response.ok) return null;

  const payload = await response.json();
  const first = Array.isArray(payload) ? payload[0] : null;
  return positiveInteger(first?.movie?.ids?.tmdb);
}

async function searchMovies(token: string, title: string, year: number | null) {
  const params = new URLSearchParams({
    query: title,
    include_adult: "false",
    language: "en-GB",
    page: "1",
  });
  if (year) params.set("primary_release_year", String(year));

  let payload = (await tmdbGet(token, `/search/movie?${params}`)) as { results?: TmdbMovie[] };
  if (year && !(payload.results ?? []).length) {
    params.delete("primary_release_year");
    payload = (await tmdbGet(token, `/search/movie?${params}`)) as { results?: TmdbMovie[] };
  }

  return (payload.results ?? [])
    .map((movie) => candidate(movie, title))
    .sort((first, second) => {
      const firstYear = year && first.year === year ? 0.2 : 0;
      const secondYear = year && second.year === year ? 0.2 : 0;
      return second.similarity + secondYear - (first.similarity + firstYear);
    })
    .slice(0, 6);
}

function classifyTitleMatch(record: ImportRecord, candidates: Candidate[]) {
  if (!candidates.length) {
    return { status: "unmatched", match: null, candidates: [], reason: "No TMDB movie results." };
  }

  const best = candidates[0];
  const second = candidates[1];
  const exact = candidates.filter((item) => item.similarity === 1);

  if (record.year) {
    const exactYear = exact.filter((item) => item.year === record.year);
    if (exactYear.length === 1) {
      return {
        status: "matched",
        match: exactYear[0],
        candidates,
        reason: "Exact title and release year.",
      };
    }

    const margin = best.similarity - (second?.similarity ?? 0);
    if (best.year === record.year && best.similarity >= 0.96 && margin >= 0.08) {
      return {
        status: "matched",
        match: best,
        candidates,
        reason: "Strong title and exact release year.",
      };
    }

    return {
      status: "ambiguous",
      match: null,
      candidates,
      reason: "The title and year do not identify one movie with enough confidence.",
    };
  }

  if (exact.length === 1) {
    return {
      status: "matched",
      match: exact[0],
      candidates,
      reason: "Unique exact title in the TMDB results.",
    };
  }


  if (
    exact.length > 1 &&
    exact[0].popularity >= 10 &&
    exact[0].popularity >= Math.max(1, exact[1].popularity) * 5
  ) {
    return {
      status: "matched",
      match: exact[0],
      candidates,
      reason: "Exact title with one clearly dominant movie result.",
    };
  }

  return {
    status: "ambiguous",
    match: null,
    candidates,
    reason:
      exact.length > 1
        ? "Several movies have this exact title; select the correct year."
        : "The title does not identify one movie with enough confidence.",
  };
}

async function matchRecord(
  tmdbToken: string,
  traktClientId: string,
  record: ImportRecord,
) {
  let stableMovie: TmdbMovie | null = null;
  let stableReason = "";

  if (record.tmdbId) {
    stableMovie = await tmdbMovie(tmdbToken, record.tmdbId);
    stableReason = "Matched by supplied TMDB ID.";
  } else if (record.imdbId) {
    stableMovie = (await findByImdb(tmdbToken, record.imdbId))[0] ?? null;
    stableReason = "Matched by supplied IMDb ID.";
  } else if (record.traktId && traktClientId) {
    const tmdbId = await tmdbIdFromTrakt(traktClientId, record.traktId);
    stableMovie = tmdbId ? await tmdbMovie(tmdbToken, tmdbId) : null;
    stableReason = "Matched by supplied Trakt ID.";
  }

  if (stableMovie) {
    const match = candidate(stableMovie);
    return {
      clientId: record.clientId,
      status: "matched",
      match,
      candidates: [match],
      reason: stableReason,
    };
  }

  if (!record.title) {
    return {
      clientId: record.clientId,
      status: "unmatched",
      match: null,
      candidates: [],
      reason: "The supplied stable ID was not found and no title was available.",
    };
  }

  return {
    clientId: record.clientId,
    ...classifyTitleMatch(record, await searchMovies(tmdbToken, record.title, record.year)),
  };
}

Deno.serve(async (request) => {
  const allowed = configuredOrigins();
  const origin = request.headers.get("Origin");
  const headers = responseHeaders(origin, allowed);

  if (request.method === "OPTIONS") {
    return origin && !allowed.has(origin)
      ? json({ error: "Origin not allowed." }, 403, headers)
      : new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, headers);
  if (!origin || !allowed.has(origin)) return json({ error: "Origin not allowed." }, 403, headers);

  const tmdbToken = Deno.env.get("TMDB_READ_ACCESS_TOKEN")?.trim();
  const traktClientId = Deno.env.get("TRAKT_CLIENT_ID")?.trim() ?? "";
  if (!tmdbToken) return json({ error: "Movie matching is not configured." }, 503, headers);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The request body must be valid JSON." }, 400, headers);
  }
  if (!isObject(body)) return json({ error: "Invalid request body." }, 400, headers);

  try {
    if (body.action === "search") {
      const title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
      if (!title) return json({ error: "A movie title is required." }, 400, headers);
      return json({ candidates: await searchMovies(tmdbToken, title, validYear(body.year)) }, 200, headers);
    }

    if (body.action !== "match" || !Array.isArray(body.records)) {
      return json({ error: 'Action must be "match" with a records array.' }, 400, headers);
    }
    if (body.records.length === 0 || body.records.length > MAX_RECORDS) {
      return json({ error: `Send between 1 and ${MAX_RECORDS} records per request.` }, 400, headers);
    }

    const records = body.records.map(parseRecord);
    if (records.some((record) => record === null)) {
      return json({ error: "One or more import records are invalid." }, 400, headers);
    }

    const validRecords = records as ImportRecord[];
    const results = new Array(validRecords.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(5, validRecords.length) },
      async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= validRecords.length) return;
          results[index] = await matchRecord(
            tmdbToken,
            traktClientId,
            validRecords[index],
          );
        }
      },
    );
    await Promise.all(workers);

    return json({ results }, 200, headers);
  } catch (error) {
    console.error(
      "[match-import-movies] request failed:",
      error instanceof Error ? error.message : String(error),
    );
    return json({ error: "Movies could not be matched right now. Please try again." }, 502, headers);
  }
});
