import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CinemaMultiSelect from "./CinemaMultiSelect.jsx";
import DateTimeFilter from "./DateTimeFilter.jsx";
import DistanceFilter from "./DistanceFilter.jsx";
import FiltersDropdown from "./FiltersDropdown.jsx";
import WatchDataModal from "./WatchDataModal.jsx";
import MovieImportModal from "./MovieImportModal.jsx";
import AuthModal from "./AuthModal.jsx";
import NativeWatchlistModal from "./NativeWatchlistModal.jsx";
import { getAuthErrorMessage } from "./authApi.js";
import {
  DEFAULT_DATE_TIME_FILTER,
  createDateTimeMatcher,
  isDefaultDateTimeFilter,
} from "./dateTimeFilter.js";
import {
  fetchAllUpcomingScreenings,
  fetchCinemaLocations,
} from "./screeningsApi.js";
import { SUPABASE_CONFIGURED } from "./supabaseClient.js";
import { londonDateKey } from "./time.js";
import { DayGroup } from "./ScreeningRow.jsx";
import MovieDayGroup from "./MovieDayGroup.jsx";
import { useAuth } from "./useAuth.js";
import { useNativeWatchlist } from "./useNativeWatchlist.js";
import { useTrakt } from "./useTrakt.js";
import {
  clearPendingWatchlistAction,
  loadPendingWatchlistAction,
  savePendingWatchlistAction,
  screeningMatchesPersonalFilters,
} from "./nativeWatchlist.js";
import {
  DEFAULT_SCREENING_FILTERS,
  countScreeningFilters,
  screeningMatchesMetadataFilters,
} from "./screeningFilters.js";
import {
  DEFAULT_DISTANCE_FILTER,
  buildCinemaDistanceData,
  distanceIncludesCinema,
  isDistanceFilterActive,
} from "./distanceFilter.js";

export default function App() {
  const [screenings, setScreenings] = useState([]);
  const [status, setStatus] = useState("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [search, setSearch] = useState("");
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [nativeWatchlistNotice, setNativeWatchlistNotice] = useState("");
  const [nativeWatchlistModalOpen, setNativeWatchlistModalOpen] = useState(false);
  const [nativeWatchlistInitialQuery, setNativeWatchlistInitialQuery] = useState("");
  const [pendingWatchlistAction, setPendingWatchlistAction] = useState(() =>
    loadPendingWatchlistAction()
  );
  const pendingWatchlistProcessingRef = useRef(false);
  const [watchDataModalOpen, setWatchDataModalOpen] = useState(false);
  const [movieImportModalOpen, setMovieImportModalOpen] = useState(false);
  const [resultsView, setResultsView] = useState("time");
  const [cinemaLocations, setCinemaLocations] = useState([]);
  const [cinemaLocationsStatus, setCinemaLocationsStatus] = useState("loading");
  const [cinemaLocationsError, setCinemaLocationsError] = useState("");
  const [distanceFilter, setDistanceFilter] = useState(() => ({
    ...DEFAULT_DISTANCE_FILTER,
  }));

  const [cinemaSelection, setCinemaSelection] = useState({
    mode: "all",
    names: [],
  });

  const [dateTimeFilter, setDateTimeFilter] = useState(() => ({
    ...DEFAULT_DATE_TIME_FILTER,
  }));

  const [minRating, setMinRating] = useState(0);
  const [screeningFilters, setScreeningFilters] = useState(() => ({
    ...DEFAULT_SCREENING_FILTERS,
  }));
  const nativeWatchlistOnly = screeningFilters.nativeWatchlistOnly;
  const traktWatchlistOnly = screeningFilters.traktWatchlistOnly;

  const trakt = useTrakt();
  const auth = useAuth();
  const nativeWatchlist = useNativeWatchlist(auth.user);

  const traktBusy =
    trakt.status === "exchanging" || trakt.status === "fetching";

  const ratingFilterDisabled =
    !trakt.isConnected ||
    trakt.ratingsStatus === "idle" ||
    trakt.ratingsStatus === "loading" ||
    (trakt.ratingsStatus === "error" && trakt.ratings.length === 0);

  let ratingFilterTitle;

  if (!trakt.isConnected) {
    ratingFilterTitle = "Connect Trakt to filter by your ratings";
  } else if (
    trakt.ratingsStatus === "idle" ||
    trakt.ratingsStatus === "loading"
  ) {
    ratingFilterTitle = "Your Trakt ratings are loading";
  } else if (
    trakt.ratingsStatus === "error" &&
    trakt.ratings.length === 0
  ) {
    ratingFilterTitle = "Your Trakt ratings are currently unavailable";
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const rows = await fetchAllUpcomingScreenings();

        if (cancelled) return;

        setScreenings(rows);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;

        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const rows = await fetchCinemaLocations();
        if (cancelled) return;
        setCinemaLocations(rows);
        setCinemaLocationsStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setCinemaLocationsError(err instanceof Error ? err.message : String(err));
        setCinemaLocationsStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!trakt.isConnected) {
      setMinRating(0);
      setScreeningFilters((current) => ({
        ...current,
        traktWatchlistOnly: false,
      }));
      return;
    }

    if (trakt.watchlistStatus === "error") {
      setScreeningFilters((current) => ({
        ...current,
        traktWatchlistOnly: false,
      }));
    }
  }, [trakt.isConnected, trakt.watchlistStatus]);

  useEffect(() => {
    if (!auth.isAuthenticated || nativeWatchlist.status === "error") {
      setScreeningFilters((current) => ({
        ...current,
        nativeWatchlistOnly: false,
      }));
    }
  }, [auth.isAuthenticated, nativeWatchlist.status]);

  useEffect(() => {
    if (auth.isAuthenticated) {
      setAuthModalOpen(false);
      setAccountError("");
      return;
    }

    setNativeWatchlistModalOpen(false);
    setNativeWatchlistInitialQuery("");
  }, [auth.isAuthenticated]);

  useEffect(() => {
    if (
      !auth.isAuthenticated ||
      nativeWatchlist.status !== "ready" ||
      !pendingWatchlistAction ||
      pendingWatchlistProcessingRef.current
    ) {
      return;
    }

    if (pendingWatchlistAction.kind === "search") {
      setNativeWatchlistInitialQuery(pendingWatchlistAction.query);
      setNativeWatchlistModalOpen(true);
      clearPendingWatchlistAction();
      setPendingWatchlistAction(null);
      return;
    }

    if (nativeWatchlist.tmdbIds.has(pendingWatchlistAction.tmdbId)) {
      clearPendingWatchlistAction();
      setPendingWatchlistAction(null);
      setNativeWatchlistNotice(
        `${pendingWatchlistAction.title || "The film"} is already on your watchlist.`
      );
      return;
    }

    pendingWatchlistProcessingRef.current = true;
    const action = pendingWatchlistAction;

    nativeWatchlist
      .add(action.tmdbId)
      .then(() => {
        clearPendingWatchlistAction();
        setPendingWatchlistAction(null);
        setNativeWatchlistNotice(
          `${action.title || "The film"} was added to your watchlist.`
        );
      })
      .catch(() => {
        // The watchlist hook exposes a safe error and keeps the pending action.
      })
      .finally(() => {
        pendingWatchlistProcessingRef.current = false;
      });
  }, [
    auth.isAuthenticated,
    nativeWatchlist.status,
    nativeWatchlist.tmdbIds,
    nativeWatchlist.add,
    pendingWatchlistAction,
  ]);

  const cinemas = useMemo(() => {
    const names = new Set();

    for (const screening of screenings) {
      if (screening.cinema_name) {
        names.add(screening.cinema_name);
      }
    }

    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [screenings]);

  const selectedCinemas = useMemo(() => {
    if (cinemaSelection.mode === "all") {
      return new Set(cinemas);
    }

    return new Set(
      cinemaSelection.names.filter((cinemaName) =>
        cinemas.includes(cinemaName)
      )
    );
  }, [cinemas, cinemaSelection]);

  const selectedCinemaCount = selectedCinemas.size;

  const allCinemasSelected =
    cinemas.length === 0 || selectedCinemaCount === cinemas.length;

  const cinemaFilterActive =
    cinemas.length > 0 && selectedCinemaCount < cinemas.length;

  const noCinemasSelected =
    cinemas.length > 0 && selectedCinemaCount === 0;

  const dateTimeFilterActive = !isDefaultDateTimeFilter(dateTimeFilter);
  const distanceFilterActive = isDistanceFilterActive(distanceFilter);
  const distanceData = useMemo(
    () => buildCinemaDistanceData(distanceFilter.origin, cinemas, cinemaLocations),
    [distanceFilter.origin, cinemas, cinemaLocations]
  );

  const handleToggleCinema = (cinemaName) => {
    setCinemaSelection((currentSelection) => {
      const nextSelection = new Set(
        currentSelection.mode === "all"
          ? cinemas
          : currentSelection.names.filter((name) => cinemas.includes(name))
      );

      if (nextSelection.has(cinemaName)) {
        nextSelection.delete(cinemaName);
      } else {
        nextSelection.add(cinemaName);
      }

      if (nextSelection.size === cinemas.length) {
        return {
          mode: "all",
          names: [],
        };
      }

      return {
        mode: "custom",
        names: cinemas.filter((name) => nextSelection.has(name)),
      };
    });
  };

  const handleSelectAllCinemas = () => {
    setCinemaSelection({
      mode: "all",
      names: [],
    });
  };

  const handleClearAllCinemas = () => {
    setCinemaSelection({
      mode: "custom",
      names: [],
    });
  };

  const handleTraktDisconnect = () => {
    setMinRating(0);
    setScreeningFilters((current) => ({
      ...current,
      traktWatchlistOnly: false,
    }));
    trakt.disconnect();
  };

  const openAuthModal = useCallback(() => {
    setAccountError("");
    setAuthModalOpen(true);
  }, []);

  const clearRecoveryMode = auth.clearRecoveryMode;

  const closeAuthModal = useCallback((reason = "cancelled") => {
    setAuthModalOpen(false);
    clearRecoveryMode();

    if (reason === "cancelled" && pendingWatchlistAction) {
      clearPendingWatchlistAction();
      setPendingWatchlistAction(null);
    }
  }, [clearRecoveryMode, pendingWatchlistAction]);

  const requestWatchlistLogin = useCallback(
    (action) => {
      const stored = savePendingWatchlistAction(action);

      if (!stored) {
        setAccountError(
          "Your selected film could not be preserved. Please log in, then try again."
        );
        setAuthModalOpen(true);
        return;
      }

      setPendingWatchlistAction(stored);
      setNativeWatchlistNotice("");
      setAccountError("");
      setAuthModalOpen(true);
    },
    []
  );

  const handleAccountLogout = useCallback(async () => {
    if (accountBusy) return;

    setAccountBusy(true);
    setAccountError("");

    try {
      await auth.signOut();
    } catch (logoutError) {
      setAccountError(getAuthErrorMessage(logoutError, "logout"));
    } finally {
      setAccountBusy(false);
    }
  }, [accountBusy, auth]);

  const openWatchDataModal = useCallback(() => {
    setWatchDataModalOpen(true);
  }, []);

  const closeWatchDataModal = useCallback(() => {
    setWatchDataModalOpen(false);
  }, []);

  const openMovieImportModal = useCallback(() => {
    setMovieImportModalOpen(true);
  }, []);

  const closeMovieImportModal = useCallback(() => {
    setMovieImportModalOpen(false);
  }, []);

  const openNativeWatchlistModal = useCallback(() => {
    setNativeWatchlistInitialQuery("");
    setNativeWatchlistModalOpen(true);
    setNativeWatchlistNotice("");
  }, []);

  const closeNativeWatchlistModal = useCallback(() => {
    setNativeWatchlistModalOpen(false);
    setNativeWatchlistInitialQuery("");
  }, []);

  const clearNativeWatchlistInitialQuery = useCallback(() => {
    setNativeWatchlistInitialQuery("");
  }, []);

  const handleToggleNativeWatchlist = useCallback(
    async ({ tmdbId, title, saved }) => {
      if (!auth.isAuthenticated) {
        requestWatchlistLogin({ kind: "add", tmdbId, title });
        return;
      }

      setNativeWatchlistNotice("");

      try {
        if (saved) {
          await nativeWatchlist.remove(tmdbId);
          setNativeWatchlistNotice(`${title} was removed from your watchlist.`);
        } else {
          await nativeWatchlist.add(tmdbId);
          setNativeWatchlistNotice(`${title} was added to your watchlist.`);
        }
      } catch {
        // The watchlist hook exposes a safe error in the page and modal.
      }
    },
    [
      auth.isAuthenticated,
      nativeWatchlist.add,
      nativeWatchlist.remove,
      requestWatchlistLogin,
    ]
  );

  const handleFindNativeWatchlistMovie = useCallback(
    (title) => {
      if (!auth.isAuthenticated) {
        requestWatchlistLogin({ kind: "search", query: title });
        return;
      }

      setNativeWatchlistInitialQuery(title);
      setNativeWatchlistModalOpen(true);
      setNativeWatchlistNotice("");
    },
    [auth.isAuthenticated, requestWatchlistLogin]
  );

  const connectTrakt = trakt.connect;

  const handleConnectTrakt = useCallback(() => {
    connectTrakt();
  }, [connectTrakt]);

  const ratingsByTmdbId = useMemo(() => {
    const ratings = new Map();

    for (const ratedMovie of trakt.ratings) {
      ratings.set(ratedMovie.tmdbId, ratedMovie.rating);
    }

    return ratings;
  }, [trakt.ratings]);

  const traktWatchlistTmdbIdSet = useMemo(
    () => new Set(trakt.watchlistTmdbIds),
    [trakt.watchlistTmdbIds]
  );

  const matchesDateTime = useMemo(
    () => createDateTimeMatcher(dateTimeFilter),
    [dateTimeFilter]
  );

  const filtered = useMemo(() => {
    const titleQuery = search.trim().toLowerCase();

    return screenings.filter((screening) => {
      if (
        titleQuery &&
        !screening.movie_title.toLowerCase().includes(titleQuery)
      ) {
        return false;
      }

      if (!selectedCinemas.has(screening.cinema_name)) {
        return false;
      }

      if (
        distanceFilterActive &&
        !distanceIncludesCinema(
          distanceData.distanceByCinema.get(screening.cinema_name),
          distanceFilter.maxMiles
        )
      ) {
        return false;
      }

      if (!matchesDateTime(screening.start_time)) {
        return false;
      }

      if (!screeningMatchesMetadataFilters(screening, screeningFilters)) {
        return false;
      }

      if (
        !screeningMatchesPersonalFilters(screening, {
          minRating,
          ratingsByTmdbId,
          nativeWatchlistOnly,
          nativeWatchlistTmdbIds: nativeWatchlist.tmdbIds,
          traktWatchlistOnly,
          traktWatchlistTmdbIds: traktWatchlistTmdbIdSet,
        })
      ) {
        return false;
      }

      return true;
    });
  }, [
    screenings,
    search,
    selectedCinemas,
    distanceFilterActive,
    distanceData,
    distanceFilter.maxMiles,
    matchesDateTime,
    screeningFilters,
    minRating,
    ratingsByTmdbId,
    nativeWatchlistOnly,
    nativeWatchlist.tmdbIds,
    traktWatchlistOnly,
    traktWatchlistTmdbIdSet,
  ]);

  const groups = useMemo(() => {
    const grouped = new Map();

    for (const screening of filtered) {
      const key = londonDateKey(screening.start_time);

      if (!grouped.has(key)) {
        grouped.set(key, []);
      }

      grouped.get(key).push(screening);
    }

    return Array.from(grouped.entries());
  }, [filtered]);

  let traktSummary = "Connected";

  if (trakt.status === "fetching") {
    traktSummary = "Loading Trakt data…";
  } else if (trakt.status === "ready") {
    const summaryParts = [];

    if (trakt.ratingsStatus === "ready") {
      summaryParts.push(
        `${trakt.ratings.length} rating${
          trakt.ratings.length === 1 ? "" : "s"
        }`
      );
    }

    if (trakt.watchlistStatus === "ready") {
      summaryParts.push(
        `${trakt.watchlistTmdbIds.length} watchlist film${
          trakt.watchlistTmdbIds.length === 1 ? "" : "s"
        }`
      );
    }

    if (summaryParts.length > 0) {
      traktSummary = summaryParts.join(" · ");
    }
  }

  let emptyMessage = "No upcoming screenings match your current filters.";

  let authContextMessage = "";
  if (pendingWatchlistAction?.kind === "add") {
    authContextMessage = `Log in to save ${
      pendingWatchlistAction.title || "this film"
    } to your watchlist.`;
  } else if (pendingWatchlistAction?.kind === "search") {
    authContextMessage = `Log in to find and save the exact version of ${pendingWatchlistAction.query}.`;
  }

  if (noCinemasSelected) {
    emptyMessage =
      "No cinemas are selected. Select at least one cinema to see screenings.";
  } else if (
    allCinemasSelected &&
    search.trim() === "" &&
    !dateTimeFilterActive &&
    !distanceFilterActive &&
    minRating === 0 &&
    countScreeningFilters(screeningFilters) === 0
  ) {
    emptyMessage = "No upcoming screenings found.";
  }

  return (
    <div className="app">
      <header className="site-header">
        <div className="site-heading-row">
          <div>
            <h1 className="site-title">London Screenings</h1>

            <p className="site-subtitle">
              Upcoming screenings in London, updated from each cinema&apos;s
              programme.
            </p>
          </div>

          <div className="header-actions">
            <div className="account-control">
              {auth.loading ? (
                <span className="account-loading" role="status">
                  Checking account…
                </span>
              ) : auth.user ? (
                <div className="account-connected">
                  <span className="account-email" title={auth.user.email}>
                    {auth.user.email}
                  </span>
                  <button
                    className="text-button"
                    type="button"
                    onClick={openNativeWatchlistModal}
                  >
                    Watchlist
                    {nativeWatchlist.status === "ready"
                      ? ` (${nativeWatchlist.items.length})`
                      : ""}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    onClick={handleAccountLogout}
                    disabled={accountBusy}
                  >
                    {accountBusy ? "Logging out…" : "Log out"}
                  </button>
                </div>
              ) : (
                <button
                  className="account-button"
                  type="button"
                  onClick={openAuthModal}
                >
                  Log in
                </button>
              )}
            </div>

            {trakt.isConnected ? (
            <div className="trakt-connected">
              <span className="trakt-summary">{traktSummary}</span>

              <div className="trakt-actions">
                <button
                  className="text-button"
                  type="button"
                  onClick={openMovieImportModal}
                  disabled={traktBusy}
                >
                  Import movie data
                </button>

                <button
                  className="text-button"
                  type="button"
                  onClick={trakt.refresh}
                  disabled={traktBusy}
                >
                  Refresh
                </button>

                <button
                  className="text-button"
                  type="button"
                  onClick={handleTraktDisconnect}
                >
                  Disconnect Trakt
                </button>
              </div>
            </div>
          ) : (
            <button
              className="trakt-button"
              type="button"
              onClick={openWatchDataModal}
              disabled={trakt.status === "exchanging"}
            >
              {trakt.status === "exchanging"
                ? "Connecting…"
                : "Connect watch data"}
            </button>
          )}
          </div>
        </div>

        {(accountError || auth.initializationError) && (
          <div className="account-message error" role="alert">
            <span>{accountError || auth.initializationError}</span>
          </div>
        )}

        {nativeWatchlist.error && (
          <div className="account-message error" role="alert">
            <span>{nativeWatchlist.error}</span>
            {auth.isAuthenticated && (
              <button
                className="text-button"
                type="button"
                onClick={() => void nativeWatchlist.refresh().catch(() => {})}
              >
                Try again
              </button>
            )}
          </div>
        )}

        {nativeWatchlistNotice && (
          <div className="account-message success" role="status">
            <span>{nativeWatchlistNotice}</span>
            <button
              className="text-button"
              type="button"
              onClick={() => setNativeWatchlistNotice("")}
            >
              Dismiss
            </button>
          </div>
        )}

        {auth.notice && (
          <div
            className={`account-message ${auth.notice.type}`}
            role={auth.notice.type === "error" ? "alert" : "status"}
          >
            <span>{auth.notice.message}</span>
            <button
              className="text-button"
              type="button"
              onClick={auth.clearNotice}
            >
              Dismiss
            </button>
          </div>
        )}

        {trakt.error && (
          <div className="trakt-error" role="status">
            <span>{trakt.error}</span>

            {trakt.isConnected && (
              <button
                className="text-button"
                type="button"
                onClick={trakt.refresh}
                disabled={traktBusy}
              >
                Try again
              </button>
            )}
          </div>
        )}
      </header>

      <div className="controls">
        <label className="search">
          <span className="search-icon" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>

          <input
            type="search"
            placeholder="Search movie title…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search movie title"
          />
        </label>

        <CinemaMultiSelect
          cinemas={cinemas}
          selectedCinemas={selectedCinemas}
          onToggleCinema={handleToggleCinema}
          onSelectAll={handleSelectAllCinemas}
          onClearAll={handleClearAllCinemas}
          disabled={status !== "ready" || cinemas.length === 0}
        />

        <DistanceFilter
          value={distanceFilter}
          onApply={setDistanceFilter}
          cinemas={cinemas}
          cinemaLocations={cinemaLocations}
          locationsStatus={cinemaLocationsStatus}
          locationsError={cinemaLocationsError}
          disabled={status !== "ready" || cinemas.length === 0}
        />

        <select
          className="filter-select rating-filter"
          value={minRating}
          onChange={(event) => setMinRating(Number(event.target.value))}
          aria-label="Filter by your Trakt rating"
          disabled={ratingFilterDisabled}
          title={ratingFilterTitle}
        >
          <option value={0}>All ratings</option>
          <option value={6}>My rating 6+</option>
          <option value={7}>My rating 7+</option>
          <option value={8}>My rating 8+</option>
          <option value={9}>My rating 9+</option>
          <option value={10}>My rating 10</option>
        </select>

        <FiltersDropdown
          value={screeningFilters}
          onApply={setScreeningFilters}
          nativeAuthenticated={auth.isAuthenticated}
          nativeWatchlistStatus={nativeWatchlist.status}
          nativeWatchlistError={nativeWatchlist.error}
          nativeWatchlistCount={nativeWatchlist.items.length}
          traktConnected={trakt.isConnected}
          traktWatchlistStatus={trakt.watchlistStatus}
          traktWatchlistError={trakt.watchlistError}
          traktWatchlistCount={trakt.watchlistTmdbIds.length}
          disabled={status !== "ready"}
        />

        <DateTimeFilter
          value={dateTimeFilter}
          onApply={setDateTimeFilter}
          disabled={status !== "ready"}
        />
      </div>

      {!SUPABASE_CONFIGURED && (
        <div className="status error">
          Supabase is not configured. Set <code>VITE_SUPABASE_URL</code> and{" "}
          <code>VITE_SUPABASE_ANON_KEY</code> in the environment.
        </div>
      )}

      {SUPABASE_CONFIGURED && status === "loading" && (
        <div className="status">
          <div className="spinner" />
          Loading upcoming screenings…
        </div>
      )}

      {SUPABASE_CONFIGURED && status === "error" && (
        <div className="status error">
          Couldn&apos;t load screenings right now. {errorMsg}
        </div>
      )}

      {SUPABASE_CONFIGURED && status === "ready" && groups.length === 0 && (
        <div className="status">{emptyMessage}</div>
      )}

      {SUPABASE_CONFIGURED && status === "ready" && groups.length > 0 && (
        <main>
          <div className="results-view-controls">
            <button
              className="results-view-toggle"
              type="button"
              onClick={() =>
                setResultsView((current) =>
                  current === "time" ? "movie" : "time"
                )
              }
            >
              {resultsView === "time" ? "By movie" : "By time"}
            </button>
          </div>

          {groups.map(([key, rows]) => (
            resultsView === "time" ? (
              <DayGroup
                key={key}
                dateKey={key}
                screenings={rows}
                ratingsByTmdbId={ratingsByTmdbId}
              />
            ) : (
              <MovieDayGroup
                key={key}
                dateKey={key}
                screenings={rows}
                ratingsByTmdbId={ratingsByTmdbId}
                nativeWatchlistTmdbIds={nativeWatchlist.tmdbIds}
                savingTmdbIds={nativeWatchlist.savingTmdbIds}
                removingTmdbIds={nativeWatchlist.removingTmdbIds}
                onToggleWatchlist={handleToggleNativeWatchlist}
                onFindMovie={handleFindNativeWatchlistMovie}
              />
            )
          ))}
        </main>
      )}

      <footer className="footer">
        {screenings.length > 0 && status === "ready" && (
          <span>
            {filtered.length} upcoming screening
            {filtered.length === 1 ? "" : "s"}

            {cinemaFilterActive
              ? selectedCinemaCount === 0
                ? " with no cinemas selected."
                : ` across ${selectedCinemaCount} selected cinema${
                    selectedCinemaCount === 1 ? "" : "s"
                  }.`
              : "."}
          </span>
        )}
      </footer>

      <AuthModal
        isAuthenticated={auth.isAuthenticated}
        isOpen={authModalOpen || auth.recoveryMode}
        onClose={closeAuthModal}
        onSignIn={auth.signIn}
        onSignUp={auth.signUp}
        onResetPassword={auth.resetPassword}
        onUpdatePassword={auth.updateUserPassword}
        recoveryMode={auth.recoveryMode}
        contextMessage={authContextMessage}
      />

      <NativeWatchlistModal
        isOpen={nativeWatchlistModalOpen}
        onClose={closeNativeWatchlistModal}
        items={nativeWatchlist.items}
        status={nativeWatchlist.status}
        error={nativeWatchlist.error}
        onClearError={nativeWatchlist.clearError}
        onSearch={nativeWatchlist.search}
        onAdd={nativeWatchlist.add}
        onRemove={nativeWatchlist.remove}
        savingTmdbIds={nativeWatchlist.savingTmdbIds}
        removingTmdbIds={nativeWatchlist.removingTmdbIds}
        screenings={screenings}
        initialQuery={nativeWatchlistInitialQuery}
        onInitialQueryConsumed={clearNativeWatchlistInitialQuery}
      />

      <WatchDataModal
        isOpen={watchDataModalOpen}
        onClose={closeWatchDataModal}
        onConnectTrakt={handleConnectTrakt}
        isConnecting={trakt.status === "exchanging"}
      />

      <MovieImportModal
        isOpen={movieImportModalOpen}
        onClose={closeMovieImportModal}
        onImport={trakt.importMovies}
      />
    </div>
  );
}
