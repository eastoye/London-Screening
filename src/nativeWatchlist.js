const PENDING_WATCHLIST_KEY = "london_screenings_pending_watchlist_action";

export function normaliseTmdbId(value) {
  const tmdbId = Number(value);
  return Number.isSafeInteger(tmdbId) && tmdbId > 0 ? tmdbId : null;
}

export function confirmedMovieTmdbId(movie) {
  if (movie?.match_status !== "matched") return null;
  return normaliseTmdbId(movie.tmdb_id);
}

export function confirmedScreeningTmdbId(screening) {
  return confirmedMovieTmdbId(screening?.movies);
}

export function buildUpcomingScreeningsByTmdbId(screenings = []) {
  const byTmdbId = new Map();

  for (const screening of screenings) {
    const tmdbId = confirmedScreeningTmdbId(screening);
    if (!tmdbId) continue;

    if (!byTmdbId.has(tmdbId)) byTmdbId.set(tmdbId, []);
    byTmdbId.get(tmdbId).push(screening);
  }

  for (const rows of byTmdbId.values()) {
    rows.sort(
      (first, second) =>
        new Date(first.start_time).getTime() -
        new Date(second.start_time).getTime()
    );
  }

  return byTmdbId;
}

export function watchlistItemIsSaved(items, tmdbId) {
  const id = normaliseTmdbId(tmdbId);
  return Boolean(id && items.some((item) => item.tmdbId === id));
}

export function screeningMatchesPersonalFilters(
  screening,
  {
    minRating = 0,
    ratingsByTmdbId = new Map(),
    nativeWatchlistOnly = false,
    nativeWatchlistTmdbIds = new Set(),
    traktWatchlistOnly = false,
    traktWatchlistTmdbIds = new Set(),
  } = {}
) {
  const ratingFilterActive = minRating > 0;
  const personalFilterActive =
    ratingFilterActive || nativeWatchlistOnly || traktWatchlistOnly;

  if (!personalFilterActive) return true;

  const tmdbId = normaliseTmdbId(screening?.movies?.tmdb_id);
  if (!tmdbId) return false;

  const userRating = ratingsByTmdbId.get(tmdbId);
  const matchesRating =
    ratingFilterActive &&
    userRating !== undefined &&
    userRating >= minRating;
  const matchesNativeWatchlist =
    nativeWatchlistOnly &&
    screening.movies?.match_status === "matched" &&
    nativeWatchlistTmdbIds.has(tmdbId);
  const matchesTraktWatchlist =
    traktWatchlistOnly && traktWatchlistTmdbIds.has(tmdbId);

  return matchesRating || matchesNativeWatchlist || matchesTraktWatchlist;
}

export function sortWatchlistItems(items = []) {
  return [...items].sort((first, second) => {
    const timeDifference =
      new Date(second.addedAt).getTime() - new Date(first.addedAt).getTime();

    if (Number.isFinite(timeDifference) && timeDifference !== 0) {
      return timeDifference;
    }

    return first.displayTitle.localeCompare(second.displayTitle);
  });
}

function normalisePendingAction(value) {
  if (!value || typeof value !== "object") return null;

  if (value.kind === "add") {
    const tmdbId = normaliseTmdbId(value.tmdbId);
    if (!tmdbId) return null;

    return {
      kind: "add",
      tmdbId,
      title: String(value.title ?? "").trim().slice(0, 500),
    };
  }

  if (value.kind === "search") {
    const query = String(value.query ?? "").trim().slice(0, 200);
    return query ? { kind: "search", query } : null;
  }

  return null;
}

function defaultSessionStorage() {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function loadPendingWatchlistAction(storage = defaultSessionStorage()) {
  if (!storage) return null;

  try {
    return normalisePendingAction(
      JSON.parse(storage.getItem(PENDING_WATCHLIST_KEY) || "null")
    );
  } catch {
    return null;
  }
}

export function savePendingWatchlistAction(
  action,
  storage = defaultSessionStorage()
) {
  const value = normalisePendingAction(action);
  if (!storage || !value) return null;

  try {
    storage.setItem(PENDING_WATCHLIST_KEY, JSON.stringify(value));
    return value;
  } catch {
    return null;
  }
}

export function clearPendingWatchlistAction(
  storage = defaultSessionStorage()
) {
  if (!storage) return;

  try {
    storage.removeItem(PENDING_WATCHLIST_KEY);
  } catch {
    // A blocked storage API must not prevent normal account use.
  }
}
