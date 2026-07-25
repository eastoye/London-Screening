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
const MAX_PAGES = 100;
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
    token_type: typeof value.token_type === "string" ? value.token_type : "bearer",
    expires_in: Number(value.expires_in),
    scope: typeof value.scope === "string" ? value.scope : "public",
    created_at: Number(value.created_at),
  };
}

export function saveTraktToken(token) {
  const valid = normaliseToken(token);
  if (!valid) throw new Error("Trakt returned an invalid token.");
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(valid));
}

export function loadTraktToken() {
  const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const token = normaliseToken(JSON.parse(raw));
    if (!token) localStorage.removeItem(TOKEN_STORAGE_KEY);
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
    response = await fetch(`${SUPABASE_URL}/functions/v1/trakt-token-exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ ...payload, redirect_uri: TRAKT_REDIRECT_URI }),
    });
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
    if (response.status === 401) throw new TraktAuthError(message);
    throw new Error(message);
  }

  const token = normaliseToken(data);
  if (!token) throw new Error("Trakt returned an invalid token.");
  return token;
}

export function exchangeTraktCode(code) {
  return callTokenFunction({ action: "exchange", code });
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
  if (!tokenNeedsRefresh(token)) return token;
  return refreshTraktToken(token.refresh_token);
}

async function fetchRatingsPages(token) {
  const ratingsByTmdbId = new Map();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`${TRAKT_API_BASE}/users/me/ratings/movies`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(PAGE_SIZE));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "trakt-api-version": "2",
        "trakt-api-key": TRAKT_CLIENT_ID,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 401) {
      throw new TraktAuthError("Your Trakt connection has expired.");
    }
    if (!response.ok) {
      throw new Error(`Trakt ratings could not be loaded (${response.status}).`);
    }

    const items = await response.json();
    if (!Array.isArray(items)) {
      throw new Error("Trakt returned invalid ratings data.");
    }

    for (const item of items) {
      const tmdbId = Number(item?.movie?.ids?.tmdb);
      const rating = Number(item?.rating);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) continue;
      if (!Number.isInteger(rating) || rating < 1 || rating > 10) continue;
      ratingsByTmdbId.set(tmdbId, {
        tmdbId,
        rating,
        title: typeof item.movie.title === "string" ? item.movie.title : "",
        year: Number.isInteger(Number(item.movie.year))
          ? Number(item.movie.year)
          : null,
      });
    }

    const pageCountHeader = response.headers.get("X-Pagination-Page-Count");
    const pageCount = pageCountHeader ? Number(pageCountHeader) : null;
    if (
      items.length < PAGE_SIZE ||
      (Number.isFinite(pageCount) && pageCount > 0 && page >= pageCount)
    ) {
      break;
    }
  }

  return Array.from(ratingsByTmdbId.values());
}

export async function fetchAllTraktRatings(token) {
  let currentToken = await ensureFreshToken(token);

  try {
    const ratings = await fetchRatingsPages(currentToken);
    return { token: currentToken, ratings };
  } catch (error) {
    if (!(error instanceof TraktAuthError)) throw error;

    currentToken = await refreshTraktToken(currentToken.refresh_token);
    const ratings = await fetchRatingsPages(currentToken);
    return { token: currentToken, ratings };
  }
}