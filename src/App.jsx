import { useEffect, useMemo, useState } from "react";
import CinemaMultiSelect from "./CinemaMultiSelect.jsx";
import DateTimeFilter from "./DateTimeFilter.jsx";
import FiltersDropdown from "./FiltersDropdown.jsx";
import {
  DEFAULT_DATE_TIME_FILTER,
  createDateTimeMatcher,
  isDefaultDateTimeFilter,
} from "./dateTimeFilter.js";
import { fetchAllUpcomingScreenings } from "./screeningsApi.js";
import { SUPABASE_CONFIGURED } from "./supabaseClient.js";
import { londonDateKey } from "./time.js";
import { DayGroup } from "./ScreeningRow.jsx";
import { useTrakt } from "./useTrakt.js";

function TraktIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.5 7.5-1.5 1.5-2-2-5 5 2 2-1.5 1.5L7 13l-1.5 1.5L4 13l3-3-1.5-1.5L7 7l1.5 1.5 5-5L15 5l1.5-1.5L18 5l-1.5 1.5 1 1z" />
    </svg>
  );
}

export default function App() {
  const [screenings, setScreenings] = useState([]);
  const [status, setStatus] = useState("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [search, setSearch] = useState("");

  const [cinemaSelection, setCinemaSelection] = useState({
    mode: "all",
    names: [],
  });

  const [dateTimeFilter, setDateTimeFilter] = useState(() => ({
    ...DEFAULT_DATE_TIME_FILTER,
  }));

  const [minRating, setMinRating] = useState(0);
  const [watchlistOnly, setWatchlistOnly] = useState(false);

  const trakt = useTrakt();

  const traktBusy =
    trakt.status === "exchanging" ||
    trakt.status === "fetching";

  const ratingFilterDisabled =
    !trakt.isConnected ||
    trakt.ratingsStatus === "idle" ||
    trakt.ratingsStatus === "loading" ||
    (trakt.ratingsStatus === "error" &&
      trakt.ratings.length === 0);

  let ratingFilterTitle;

  if (!trakt.isConnected) {
    ratingFilterTitle =
      "Connect Trakt to filter by your ratings";
  } else if (
    trakt.ratingsStatus === "idle" ||
    trakt.ratingsStatus === "loading"
  ) {
    ratingFilterTitle =
      "Your Trakt ratings are loading";
  } else if (
    trakt.ratingsStatus === "error" &&
    trakt.ratings.length === 0
  ) {
    ratingFilterTitle =
      "Your Trakt ratings are currently unavailable";
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const rows =
          await fetchAllUpcomingScreenings();

        if (cancelled) return;

        setScreenings(rows);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;

        setErrorMsg(
          err instanceof Error
            ? err.message
            : String(err)
        );

        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!trakt.isConnected) {
      setMinRating(0);
      setWatchlistOnly(false);
      return;
    }

    if (trakt.watchlistStatus === "error") {
      setWatchlistOnly(false);
    }
  }, [
    trakt.isConnected,
    trakt.watchlistStatus,
  ]);

  const cinemas = useMemo(() => {
    const names = new Set();

    for (const screening of screenings) {
      if (screening.cinema_name) {
        names.add(screening.cinema_name);
      }
    }

    return Array.from(names).sort((a, b) =>
      a.localeCompare(b)
    );
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

  const selectedCinemaCount =
    selectedCinemas.size;

  const allCinemasSelected =
    cinemas.length === 0 ||
    selectedCinemaCount === cinemas.length;

  const cinemaFilterActive =
    cinemas.length > 0 &&
    selectedCinemaCount < cinemas.length;

  const noCinemasSelected =
    cinemas.length > 0 &&
    selectedCinemaCount === 0;

  const dateTimeFilterActive =
    !isDefaultDateTimeFilter(dateTimeFilter);

  const handleToggleCinema = (cinemaName) => {
    setCinemaSelection((currentSelection) => {
      const nextSelection = new Set(
        currentSelection.mode === "all"
          ? cinemas
          : currentSelection.names.filter(
              (name) => cinemas.includes(name)
            )
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
        names: cinemas.filter((name) =>
          nextSelection.has(name)
        ),
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
    setWatchlistOnly(false);
    trakt.disconnect();
  };

  const ratingsByTmdbId = useMemo(() => {
    const ratings = new Map();

    for (const ratedMovie of trakt.ratings) {
      ratings.set(
        ratedMovie.tmdbId,
        ratedMovie.rating
      );
    }

    return ratings;
  }, [trakt.ratings]);

  const watchlistTmdbIdSet = useMemo(
    () => new Set(trakt.watchlistTmdbIds),
    [trakt.watchlistTmdbIds]
  );

  const matchesDateTime = useMemo(
    () => createDateTimeMatcher(dateTimeFilter),
    [dateTimeFilter]
  );

  const filtered = useMemo(() => {
    const titleQuery =
      search.trim().toLowerCase();

    return screenings.filter((screening) => {
      if (
        titleQuery &&
        !screening.movie_title
          .toLowerCase()
          .includes(titleQuery)
      ) {
        return false;
      }

      if (
        !selectedCinemas.has(
          screening.cinema_name
        )
      ) {
        return false;
      }

      if (
        !matchesDateTime(
          screening.start_time
        )
      ) {
        return false;
      }

      let tmdbId = null;

      if (minRating > 0 || watchlistOnly) {
        const possibleTmdbId = Number(
          screening.movies?.tmdb_id
        );

        if (
          !Number.isInteger(possibleTmdbId) ||
          possibleTmdbId <= 0
        ) {
          return false;
        }

        tmdbId = possibleTmdbId;
      }

      if (minRating > 0) {
        const userRating =
          ratingsByTmdbId.get(tmdbId);

        if (
          userRating === undefined ||
          userRating < minRating
        ) {
          return false;
        }
      }

      if (
        watchlistOnly &&
        !watchlistTmdbIdSet.has(tmdbId)
      ) {
        return false;
      }

      return true;
    });
  }, [
    screenings,
    search,
    selectedCinemas,
    matchesDateTime,
    minRating,
    ratingsByTmdbId,
    watchlistOnly,
    watchlistTmdbIdSet,
  ]);

  const groups = useMemo(() => {
    const grouped = new Map();

    for (const screening of filtered) {
      const key = londonDateKey(
        screening.start_time
      );

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
          trakt.ratings.length === 1
            ? ""
            : "s"
        }`
      );
    }

    if (trakt.watchlistStatus === "ready") {
      summaryParts.push(
        `${trakt.watchlistTmdbIds.length} watchlist film${
          trakt.watchlistTmdbIds.length === 1
            ? ""
            : "s"
        }`
      );
    }

    if (summaryParts.length > 0) {
      traktSummary = summaryParts.join(" · ");
    }
  }

  let emptyMessage =
    "No upcoming screenings match your current filters.";

  if (noCinemasSelected) {
    emptyMessage =
      "No cinemas are selected. Select at least one cinema to see screenings.";
  } else if (
    allCinemasSelected &&
    search.trim() === "" &&
    !dateTimeFilterActive &&
    minRating === 0 &&
    !watchlistOnly
  ) {
    emptyMessage =
      "No upcoming screenings found.";
  }

  return (
    <div className="app">
      <header className="site-header">
        <div className="site-heading-row">
          <div>
            <h1 className="site-title">
              London Screenings
            </h1>

            <p className="site-subtitle">
              Upcoming screenings in London,
              updated from each cinema&apos;s
              programme.
            </p>
          </div>

          {trakt.isConnected ? (
            <div className="trakt-connected">
              <span className="trakt-summary">
                {traktSummary}
              </span>

              <div className="trakt-actions">
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
                  onClick={
                    handleTraktDisconnect
                  }
                >
                  Disconnect Trakt
                </button>
              </div>
            </div>
          ) : (
            <button
              className="trakt-button"
              type="button"
              onClick={trakt.connect}
              disabled={
                trakt.status === "exchanging"
              }
            >
              <TraktIcon />

              {trakt.status === "exchanging"
                ? "Connecting…"
                : "Connect Trakt"}
            </button>
          )}
        </div>

        {trakt.error && (
          <div
            className="trakt-error"
            role="status"
          >
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
          <span
            className="search-icon"
            aria-hidden="true"
          >
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
              <circle
                cx="11"
                cy="11"
                r="8"
              />

              <line
                x1="21"
                y1="21"
                x2="16.65"
                y2="16.65"
              />
            </svg>
          </span>

          <input
            type="search"
            placeholder="Search movie title…"
            value={search}
            onChange={(event) =>
              setSearch(event.target.value)
            }
            aria-label="Search movie title"
          />
        </label>

        <CinemaMultiSelect
          cinemas={cinemas}
          selectedCinemas={selectedCinemas}
          onToggleCinema={
            handleToggleCinema
          }
          onSelectAll={
            handleSelectAllCinemas
          }
          onClearAll={
            handleClearAllCinemas
          }
          disabled={
            status !== "ready" ||
            cinemas.length === 0
          }
        />

        <select
          className="filter-select rating-filter"
          value={minRating}
          onChange={(event) =>
            setMinRating(
              Number(event.target.value)
            )
          }
          aria-label="Filter by your Trakt rating"
          disabled={ratingFilterDisabled}
          title={ratingFilterTitle}
        >
          <option value={0}>
            All ratings
          </option>

          <option value={6}>
            My rating 6+
          </option>

          <option value={7}>
            My rating 7+
          </option>

          <option value={8}>
            My rating 8+
          </option>

          <option value={9}>
            My rating 9+
          </option>

          <option value={10}>
            My rating 10
          </option>
        </select>

        <FiltersDropdown
          watchlistOnly={watchlistOnly}
          onApply={setWatchlistOnly}
          isConnected={trakt.isConnected}
          watchlistStatus={
            trakt.watchlistStatus
          }
          watchlistError={
            trakt.watchlistError
          }
          watchlistCount={
            trakt.watchlistTmdbIds.length
          }
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
          Supabase is not configured. Set{" "}
          <code>VITE_SUPABASE_URL</code> and{" "}
          <code>VITE_SUPABASE_ANON_KEY</code>{" "}
          in the environment.
        </div>
      )}

      {SUPABASE_CONFIGURED &&
        status === "loading" && (
          <div className="status">
            <div className="spinner" />
            Loading upcoming screenings…
          </div>
        )}

      {SUPABASE_CONFIGURED &&
        status === "error" && (
          <div className="status error">
            Couldn&apos;t load screenings
            right now. {errorMsg}
          </div>
        )}

      {SUPABASE_CONFIGURED &&
        status === "ready" &&
        groups.length === 0 && (
          <div className="status">
            {emptyMessage}
          </div>
        )}

      {SUPABASE_CONFIGURED &&
        status === "ready" &&
        groups.length > 0 && (
          <main>
            {groups.map(([key, rows]) => (
              <DayGroup
                key={key}
                dateKey={key}
                screenings={rows}
                ratingsByTmdbId={
                  ratingsByTmdbId
                }
              />
            ))}
          </main>
        )}

      <footer className="footer">
        {screenings.length > 0 &&
          status === "ready" && (
            <span>
              {filtered.length} upcoming
              screening
              {filtered.length === 1
                ? ""
                : "s"}

              {cinemaFilterActive
                ? selectedCinemaCount === 0
                  ? " with no cinemas selected."
                  : ` across ${selectedCinemaCount} selected cinema${
                      selectedCinemaCount ===
                      1
                        ? ""
                        : "s"
                    }.`
                : "."}
            </span>
          )}
      </footer>
    </div>
  );
}