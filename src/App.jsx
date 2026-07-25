import { useEffect, useMemo, useState } from "react";
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
  const [cinema, setCinema] = useState("all");
  const [minRating, setMinRating] = useState(0);
  const trakt = useTrakt();

  const traktBusy =
    trakt.status === "exchanging" || trakt.status === "fetching";

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
    if (!trakt.isConnected) setMinRating(0);
  }, [trakt.isConnected]);

  const cinemas = useMemo(() => {
    const names = new Set();

    for (const screening of screenings) {
      names.add(screening.cinema_name);
    }

    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [screenings]);

  const ratingsByTmdbId = useMemo(() => {
    const ratings = new Map();

    for (const ratedMovie of trakt.ratings) {
      ratings.set(ratedMovie.tmdbId, ratedMovie.rating);
    }

    return ratings;
  }, [trakt.ratings]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();

    return screenings.filter((screening) => {
      if (cinema !== "all" && screening.cinema_name !== cinema) {
        return false;
      }

      if (
        query &&
        !screening.movie_title.toLowerCase().includes(query)
      ) {
        return false;
      }

      if (minRating > 0) {
        const tmdbId = Number(screening.movies?.tmdb_id);
        const userRating =
          Number.isInteger(tmdbId) && tmdbId > 0
            ? ratingsByTmdbId.get(tmdbId)
            : undefined;

        if (userRating === undefined || userRating < minRating) {
          return false;
        }
      }

      return true;
    });
  }, [screenings, search, cinema, minRating, ratingsByTmdbId]);

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
    traktSummary = "Loading ratings…";
  } else if (trakt.status === "error") {
    traktSummary = "Ratings unavailable";
  } else if (trakt.status === "ready") {
    traktSummary = `${trakt.ratings.length} movie rating${
      trakt.ratings.length === 1 ? "" : "s"
    }`;
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

          {trakt.isConnected ? (
            <div className="trakt-connected">
              <span className="trakt-summary">{traktSummary}</span>

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
                  onClick={trakt.disconnect}
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
              disabled={trakt.status === "exchanging"}
            >
              <TraktIcon />
              {trakt.status === "exchanging"
                ? "Connecting…"
                : "Connect Trakt"}
            </button>
          )}
        </div>

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

        <select
          className="filter-select cinema-filter"
          value={cinema}
          onChange={(event) => setCinema(event.target.value)}
          aria-label="Filter by cinema"
        >
          <option value="all">All cinemas</option>

          {cinemas.map((cinemaName) => (
            <option key={cinemaName} value={cinemaName}>
              {cinemaName}
            </option>
          ))}
        </select>

        <select
          className="filter-select rating-filter"
          value={minRating}
          onChange={(event) => setMinRating(Number(event.target.value))}
          aria-label="Filter by your Trakt rating"
          disabled={!trakt.isConnected || traktBusy}
          title={
            !trakt.isConnected
              ? "Connect Trakt to filter by your ratings"
              : undefined
          }
        >
          <option value={0}>All ratings</option>
          <option value={6}>My rating 6+</option>
          <option value={7}>My rating 7+</option>
          <option value={8}>My rating 8+</option>
          <option value={9}>My rating 9+</option>
          <option value={10}>My rating 10</option>
        </select>
      </div>

      {!SUPABASE_CONFIGURED && (
        <div className="status error">
          Supabase is not configured. Set{" "}
          <code>VITE_SUPABASE_URL</code> and{" "}
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

      {SUPABASE_CONFIGURED &&
        status === "ready" &&
        groups.length === 0 && (
          <div className="status">
            {minRating > 0
              ? `No upcoming screenings match your ${minRating}+ Trakt rating filter.`
              : "No upcoming screenings found."}
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
                ratingsByTmdbId={ratingsByTmdbId}
              />
            ))}
          </main>
        )}

      <footer className="footer">
        {screenings.length > 0 && status === "ready" && (
          <span>
            {filtered.length} upcoming screening
            {filtered.length === 1 ? "" : "s"}
            {cinema !== "all" ? ` at ${cinema}` : ""}.
          </span>
        )}
      </footer>
    </div>
  );
}