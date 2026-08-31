const TRAKT_API_BASE = "https://api.trakt.tv";
const TRAKT_CLIENT_ID = (import.meta.env.VITE_TRAKT_CLIENT_ID || "").trim();
const TRAKT_REDIRECT_URI = (
  import.meta.env.VITE_TRAKT_REDIRECT_URI ||
  "https://london-screenings-tq8c.bolt.host"
).trim();
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || "").trim();
const SUPABASE_ANON_KEY = (
  import.meta.env.VITE_SUPABASE_ANON_KEY || ""
).trim();

const TOKEN_STORAGE_KEY = "london_screenings_trakt_token";
const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
const SYNC_BATCH_SIZE = 200;
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export const TRAKT_CONFIGURED = Boolean(
  TRAKT_CLIENT_ID && TRAKT_REDIRECT_URI && SUPABASE_URL && SUPABASE_ANON_KEY
);

export class TraktAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "TraktAuthError";
  }
}

function isToken(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.access_token === "string" &&
      typeof value.refresh_token === "string" &&
      Number.isFinite(Number(value.expires_in)) &&
      Number.isFinite(Number(value.created_at))
  );
}

function normaliseToken(value) {
  if (!isToken(value)) return null;

  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    token_type:
      typeof value.token_type === "string" ? value.token_type : "bearer",
    expires_in: Number(value.expires_in),
    scope: typeof value.scope === "string" ? value.scope : "public",
    created_at: Number(value.created_at),
  };
}

export function saveTraktToken(token) {
  const valid = normaliseToken(token);

  if (!valid) {
    throw new Error("Trakt returned an invalid token.");
  }

  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(valid));
}

export function loadTraktToken() {
  const raw = localStorage.getItem(TOKEN_STORAGE_KEY);

  if (!raw) return null;

  try {
    const token = normaliseToken(JSON.parse(raw));

    if (!token) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }

    return token;
  } catch {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    return null;
  }
}

export function clearTraktToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function getTraktAuthorizationUrl(state) {
  if (!TRAKT_CONFIGURED) {
    throw new Error("Trakt is not configured for this site yet.");
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: TRAKT_CLIENT_ID,
    redirect_uri: TRAKT_REDIRECT_URI,
    state,
  });

  return `https://trakt.tv/oauth/authorize?${params.toString()}`;
}

async function callTokenFunction(payload) {
  if (!TRAKT_CONFIGURED) {
    throw new Error("Trakt is not configured for this site yet.");
  }

  let response;

  try {
    response = await fetch(
      `${SUPABASE_URL}/functions/v1/trakt-token-exchange`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          ...payload,
          redirect_uri: TRAKT_REDIRECT_URI,
        }),
      }
    );
  } catch {
    throw new Error("The Trakt connection service could not be reached.");
  }

  let data = {};

  try {
    data = await response.json();
  } catch {
    // A useful generic error is returned below.
  }

  if (!response.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : "Trakt could not complete the connection.";

    if (response.status === 401) {
      throw new TraktAuthError(message);
    }

    throw new Error(message);
  }

  const token = normaliseToken(data);

  if (!token) {
    throw new Error("Trakt returned an invalid token.");
  }

  return token;
}

export function exchangeTraktCode(code) {
  return callTokenFunction({
    action: "exchange",
    code,
  });
}

export function refreshTraktToken(refreshToken) {
  return callTokenFunction({
    action: "refresh",
    refresh_token: refreshToken,
  });
}

function tokenNeedsRefresh(token) {
  const expiresAt = (token.created_at + token.expires_in) * 1000;
  return expiresAt <= Date.now() + REFRESH_MARGIN_MS;
}

async function ensureFreshToken(token) {
  if (!tokenNeedsRefresh(token)) {
    return token;
  }

  return refreshTraktToken(token.refresh_token);
}

function traktRequestHeaders(token) {
  return {
    Authorization: `Bearer ${token.access_token}`,
    "trakt-api-version": "2",
    "trakt-api-key": TRAKT_CLIENT_ID,
    "Content-Type": "application/json",
  };
}

function paginationPageCount(response) {
  const rawValue = response.headers.get(
    "X-Pagination-Page-Count"
  );

  if (!rawValue) return null;

  const value = Number(rawValue);

  return Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function paginationIsComplete(response, page, itemCount) {
  const pageCount = paginationPageCount(response);

  if (pageCount !== null) {
    return pageCount === 0 || page >= pageCount;
  }

  return itemCount < PAGE_SIZE;
}

async function fetchRatingsPages(token) {
  const ratingsByTmdbId = new Map();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(
      `${TRAKT_API_BASE}/users/me/ratings/movies`
    );

    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(PAGE_SIZE));

    const response = await fetch(url, {
      headers: traktRequestHeaders(token),
    });

    if (response.status === 401) {
      throw new TraktAuthError(
        "Your Trakt connection has expired."
      );
    }

    if (!response.ok) {
      throw new Error(
        `Trakt ratings could not be loaded (${response.status}).`
      );
    }

    const items = await response.json();

    if (!Array.isArray(items)) {
      throw new Error("Trakt returned invalid ratings data.");
    }

    for (const item of items) {
      const tmdbId = Number(item?.movie?.ids?.tmdb);
      const rating = Number(item?.rating);

      if (
        !Number.isInteger(tmdbId) ||
        tmdbId <= 0
      ) {
        continue;
      }

      if (
        !Number.isInteger(rating) ||
        rating < 1 ||
        rating > 10
      ) {
        continue;
      }

      ratingsByTmdbId.set(tmdbId, {
        tmdbId,
        rating,
        title:
          typeof item.movie.title === "string"
            ? item.movie.title
            : "",
        year: Number.isInteger(Number(item.movie.year))
          ? Number(item.movie.year)
          : null,
      });
    }

    if (
      paginationIsComplete(
        response,
        page,
        items.length
      )
    ) {
      return Array.from(ratingsByTmdbId.values());
    }
  }

  throw new Error(
    "Trakt returned too many ratings pages to load safely."
  );
}

async function fetchWatchlistPages(token) {
  const watchlistTmdbIds = new Set();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(
      `${TRAKT_API_BASE}/users/me/watchlist/movies/added`
    );

    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(PAGE_SIZE));

    const response = await fetch(url, {
      headers: traktRequestHeaders(token),
    });

    if (response.status === 401) {
      throw new TraktAuthError(
        "Your Trakt connection has expired."
      );
    }

    if (!response.ok) {
      throw new Error(
        `Your Trakt watchlist could not be loaded (${response.status}).`
      );
    }

    const items = await response.json();

    if (!Array.isArray(items)) {
      throw new Error(
        "Trakt returned invalid watchlist data."
      );
    }

    for (const item of items) {
      const tmdbId = Number(item?.movie?.ids?.tmdb);

      if (
        !Number.isInteger(tmdbId) ||
        tmdbId <= 0
      ) {
        continue;
      }

      watchlistTmdbIds.add(tmdbId);
    }

    if (
      paginationIsComplete(
        response,
        page,
        items.length
      )
    ) {
      return Array.from(watchlistTmdbIds).sort(
        (firstId, secondId) => firstId - secondId
      );
    }
  }

  throw new Error(
    "Trakt returned too many watchlist pages to load safely."
  );
}

export async function fetchAllTraktRatings(token) {
  let currentToken = await ensureFreshToken(token);

  try {
    const ratings = await fetchRatingsPages(currentToken);

    return {
      token: currentToken,
      ratings,
    };
  } catch (error) {
    if (!(error instanceof TraktAuthError)) {
      throw error;
    }

    currentToken = await refreshTraktToken(
      currentToken.refresh_token
    );

    const ratings = await fetchRatingsPages(currentToken);

    return {
      token: currentToken,
      ratings,
    };
  }
}

export async function fetchAllTraktWatchlist(token) {
  let currentToken = await ensureFreshToken(token);

  try {
    const watchlistTmdbIds =
      await fetchWatchlistPages(currentToken);

    return {
      token: currentToken,
      watchlistTmdbIds,
    };
  } catch (error) {
    if (!(error instanceof TraktAuthError)) {
      throw error;
    }

    currentToken = await refreshTraktToken(
      currentToken.refresh_token
    );

    const watchlistTmdbIds =
      await fetchWatchlistPages(currentToken);

    return {
      token: currentToken,
      watchlistTmdbIds,
    };
  }
}

function syncCount(value, section, field) {
  const count = Number(value?.[section]?.[field]);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function notFoundTmdbIds(value) {
  const movies = Array.isArray(value?.not_found?.movies)
    ? value.not_found.movies
    : [];

  return movies
    .map((movie) => Number(movie?.ids?.tmdb))
    .filter((id) => Number.isInteger(id) && id > 0);
}

async function postTraktSync(token, path, movies) {
  const response = await fetch(`${TRAKT_API_BASE}${path}`, {
    method: "POST",
    headers: traktRequestHeaders(token),
    body: JSON.stringify({ movies }),
  });

  if (response.status === 401) {
    throw new TraktAuthError("Your Trakt connection has expired.");
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    const suffix = response.status === 429 && retryAfter
      ? ` Try again in about ${retryAfter} seconds.`
      : "";
    throw new Error(`Trakt could not save this batch (${response.status}).${suffix}`);
  }

  return data;
}

async function postTraktSyncWithRefresh(token, path, movies) {
  let currentToken = await ensureFreshToken(token);

  try {
    return {
      token: currentToken,
      data: await postTraktSync(currentToken, path, movies),
    };
  } catch (error) {
    if (!(error instanceof TraktAuthError)) throw error;

    currentToken = await refreshTraktToken(currentToken.refresh_token);
    return {
      token: currentToken,
      data: await postTraktSync(currentToken, path, movies),
    };
  }
}

function emptySyncSummary(requested = 0) {
  return {
    requested,
    added: 0,
    updated: 0,
    existing: 0,
    failed: 0,
    failedTmdbIds: [],
    errors: [],
  };
}

async function syncMovieBatches(token, path, items, responseSection, options = {}) {
  let currentToken = token;
  const summary = emptySyncSummary(items.length);

  for (let index = 0; index < items.length; index += SYNC_BATCH_SIZE) {
    const batch = items.slice(index, index + SYNC_BATCH_SIZE);

    try {
      const result = await postTraktSyncWithRefresh(
        currentToken,
        path,
        batch.map((item) => ({
          ...(item.rating ? { rating: item.rating } : {}),
          ...(item.watchedAt ? { watched_at: item.watchedAt } : {}),
          ids: { tmdb: item.tmdbId },
        }))
      );

      currentToken = result.token;
      const notFound = notFoundTmdbIds(result.data);
      const notFoundSet = new Set(notFound);

      if (options.classifyOperations) {
        for (const item of batch) {
          if (!notFoundSet.has(item.tmdbId)) {
            summary[item.operation === "update" ? "updated" : "added"] += 1;
          }
        }
      } else {
        summary.added += syncCount(result.data, "added", responseSection);
        summary.updated += syncCount(result.data, "updated", responseSection);
        summary.existing += syncCount(result.data, "existing", responseSection);
      }

      summary.failed += notFound.length;
      summary.failedTmdbIds.push(...notFound);
    } catch (error) {
      if (error instanceof TraktAuthError) throw error;

      summary.failed += batch.length;
      summary.failedTmdbIds.push(...batch.map((item) => item.tmdbId));
      summary.errors.push(
        error instanceof Error ? error.message : "A Trakt batch failed."
      );
    }
  }

  return { token: currentToken, summary };
}

export async function syncTraktImport(token, records, existingData = {}) {
  const existingWatchlist = new Set(
    (existingData.watchlistTmdbIds || []).map(Number)
  );
  const existingRatings = new Map(
    (existingData.ratings || []).map((item) => [Number(item.tmdbId), Number(item.rating)])
  );
  const requestedWatchlistItems = records
    .filter((record) => record.watchlist)
    .map((record) => ({ tmdbId: Number(record.selectedTmdbId) }));
  const watchlistItems = requestedWatchlistItems.filter(
    (item) => !existingWatchlist.has(item.tmdbId)
  );
  const requestedRatingItems = records
    .filter((record) => Number.isInteger(record.rating))
    .map((record) => ({
      tmdbId: Number(record.selectedTmdbId),
      rating: record.rating,
    }));
  const watchedAt = new Date().toISOString();

  const historyItems = requestedRatingItems.map((item) => ({
    tmdbId: item.tmdbId,
    watchedAt,
  }));
  const unchangedRatings = requestedRatingItems.filter(
    (item) => existingRatings.get(item.tmdbId) === item.rating
  );
  const ratingItems = requestedRatingItems
    .filter((item) => existingRatings.get(item.tmdbId) !== item.rating)
    .map((item) => ({
      ...item,
      operation: existingRatings.has(item.tmdbId) ? "update" : "add",
    }));

  let currentToken = token;
  let watchlist = emptySyncSummary(requestedWatchlistItems.length);
  let ratings = emptySyncSummary(requestedRatingItems.length);
  let history = emptySyncSummary(historyItems.length);

  watchlist.existing = requestedWatchlistItems.length - watchlistItems.length;
  ratings.existing = unchangedRatings.length;

  if (watchlistItems.length) {
    const result = await syncMovieBatches(
      currentToken,
      "/sync/watchlist",
      watchlistItems,
      "movies"
    );
    currentToken = result.token;
    watchlist = {
      ...result.summary,
      requested: requestedWatchlistItems.length,
      existing: watchlist.existing + result.summary.existing,
    };
  }

  if (historyItems.length) {
    const result = await syncMovieBatches(
      currentToken,
      "/sync/history",
      historyItems,
      "movies"
    );

    currentToken = result.token;
    history = {
      ...result.summary,
      requested: historyItems.length,
    };
  }

  if (ratingItems.length) {
    const result = await syncMovieBatches(
      currentToken,
      "/sync/ratings",
      ratingItems,
      "movies",
      { classifyOperations: true }
    );
    currentToken = result.token;
    ratings = {
      ...result.summary,
      requested: requestedRatingItems.length,
      existing: ratings.existing,
    };
  }

  return { token: currentToken, watchlist, ratings, history };
}
