import { useEffect, useId, useMemo, useRef, useState } from "react";
import ScreeningPoster from "./ScreeningPoster.jsx";
import { buildUpcomingScreeningsByTmdbId } from "./nativeWatchlist.js";
import "./NativeWatchlistModal.css";

const nextScreeningFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function SavedFilm({ item, upcoming, removing, onRemove }) {
  const count = upcoming.length;
  const next = upcoming[0];

  return (
    <article className="native-watchlist-film">
      <ScreeningPoster
        movie={{ match_status: "matched", poster_path: item.posterPath }}
        className="native-watchlist-poster"
      />

      <div className="native-watchlist-film-body">
        <h3>
          {item.displayTitle}
          {item.releaseYear ? ` (${item.releaseYear})` : ""}
        </h3>

        {count > 0 ? (
          <p className="native-watchlist-upcoming">
            {count} upcoming screening{count === 1 ? "" : "s"}
            {next?.start_time
              ? ` · Next ${nextScreeningFormatter.format(
                  new Date(next.start_time)
                )}`
              : ""}
          </p>
        ) : (
          <p className="native-watchlist-no-screenings">
            No upcoming London screenings
          </p>
        )}
      </div>

      <button
        className="native-watchlist-remove"
        type="button"
        disabled={removing}
        onClick={() => onRemove(item.tmdbId)}
        aria-label={`Remove ${item.displayTitle} from your watchlist`}
      >
        {removing ? "Removing…" : "Remove"}
      </button>
    </article>
  );
}

function SearchCandidate({ candidate, saved, saving, onAdd }) {
  return (
    <article className="native-watchlist-candidate">
      <ScreeningPoster
        movie={{ match_status: "matched", poster_path: candidate.posterPath }}
        className="native-watchlist-poster"
      />

      <div className="native-watchlist-candidate-body">
        <h3>
          {candidate.title}
          {candidate.releaseYear ? ` (${candidate.releaseYear})` : ""}
        </h3>

        {candidate.originalTitle && (
          <p className="native-watchlist-original-title">
            Original title: {candidate.originalTitle}
          </p>
        )}

        {candidate.overview && (
          <p className="native-watchlist-overview">{candidate.overview}</p>
        )}
      </div>

      <button
        className={`native-watchlist-add${saved ? " is-saved" : ""}`}
        type="button"
        disabled={saved || saving}
        onClick={() => onAdd(candidate.tmdbId)}
        aria-label={
          saved
            ? `${candidate.title} is already on your watchlist`
            : `Add ${candidate.title} to your watchlist`
        }
      >
        {saved ? "Saved" : saving ? "Saving…" : "Add"}
      </button>
    </article>
  );
}

export default function NativeWatchlistModal({
  isOpen,
  onClose,
  items,
  status,
  error,
  onClearError,
  onSearch,
  onAdd,
  onRemove,
  savingTmdbIds,
  removingTmdbIds,
  screenings,
  initialQuery = "",
  onInitialQueryConsumed,
}) {
  const [view, setView] = useState("saved");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchComplete, setSearchComplete] = useState(false);
  const dialogRef = useRef(null);
  const searchInputRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  const upcomingByTmdbId = useMemo(
    () => buildUpcomingScreeningsByTmdbId(screenings),
    [screenings]
  );
  const savedTmdbIds = useMemo(
    () => new Set(items.map((item) => item.tmdbId)),
    [items]
  );

  useEffect(() => {
    if (!isOpen) return undefined;

    previousFocusRef.current = document.activeElement;
    const requestedQuery = String(initialQuery ?? "").trim();
    setView(requestedQuery ? "search" : "saved");
    setQuery(requestedQuery);
    setCandidates([]);
    setSearchError("");
    setSearchComplete(false);
    onClearError?.();
    onInitialQueryConsumed?.();

    const focusTimer = window.setTimeout(() => {
      if (requestedQuery) searchInputRef.current?.focus();
      else closeButtonRef.current?.focus();
    }, 0);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [
    isOpen,
    onClearError,
    onClose,
    onInitialQueryConsumed,
  ]);

  useEffect(() => {
    if (isOpen && view === "search") {
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [isOpen, view]);

  if (!isOpen) return null;

  const handleSearch = async (event) => {
    event.preventDefault();
    if (searching) return;

    const cleanQuery = query.trim();
    if (cleanQuery.length < 2) {
      setSearchError("Enter at least two characters to search.");
      return;
    }

    setSearching(true);
    setSearchError("");
    setSearchComplete(false);

    try {
      setCandidates(await onSearch(cleanQuery));
      setSearchComplete(true);
    } catch (requestError) {
      setSearchError(requestError.message);
      setCandidates([]);
    } finally {
      setSearching(false);
    }
  };

  const handleAdd = async (tmdbId) => {
    setSearchError("");
    try {
      await onAdd(tmdbId);
    } catch (addError) {
      setSearchError(addError.message);
    }
  };

  const handleRemove = async (tmdbId) => {
    try {
      await onRemove(tmdbId);
    } catch {
      // The hook exposes its stable user-facing error in the dialog.
    }
  };

  const handleBackdropPointerDown = (event) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <div
      className="native-watchlist-backdrop"
      onPointerDown={handleBackdropPointerDown}
    >
      <section
        ref={dialogRef}
        className="native-watchlist-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="native-watchlist-topbar">
          <div>
            <span className="native-watchlist-eyebrow">Your account</span>
            <h2 id={titleId}>Watchlist</h2>
            <p id={descriptionId}>
              Save exact films by TMDB identity and keep them across devices.
            </p>
          </div>

          <button
            ref={closeButtonRef}
            className="native-watchlist-close"
            type="button"
            aria-label="Close watchlist"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="native-watchlist-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "saved"}
            className={view === "saved" ? "is-selected" : ""}
            onClick={() => setView("saved")}
          >
            Saved films ({items.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "search"}
            className={view === "search" ? "is-selected" : ""}
            onClick={() => setView("search")}
          >
            Find a film
          </button>
        </div>

        {(error || searchError) && (
          <div className="native-watchlist-error" role="alert">
            {searchError || error}
          </div>
        )}

        <div className="native-watchlist-content">
          {view === "saved" ? (
            <div className="native-watchlist-saved">
              {status === "loading" && items.length === 0 ? (
                <div className="native-watchlist-empty" role="status">
                  Loading your watchlist…
                </div>
              ) : items.length === 0 ? (
                <div className="native-watchlist-empty">
                  <strong>Your watchlist is empty.</strong>
                  <span>
                    Use Find a film, or save a confirmed film from the By Movie
                    view.
                  </span>
                </div>
              ) : (
                items.map((item) => (
                  <SavedFilm
                    key={item.tmdbId}
                    item={item}
                    upcoming={upcomingByTmdbId.get(item.tmdbId) ?? []}
                    removing={removingTmdbIds.has(item.tmdbId)}
                    onRemove={handleRemove}
                  />
                ))
              )}
            </div>
          ) : (
            <div className="native-watchlist-search-view">
              <form className="native-watchlist-search" onSubmit={handleSearch}>
                <label htmlFor={`${titleId}-search`}>Search TMDB films</label>
                <div>
                  <input
                    ref={searchInputRef}
                    id={`${titleId}-search`}
                    type="search"
                    value={query}
                    maxLength={200}
                    placeholder="Film title"
                    disabled={searching}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <button type="submit" disabled={searching || query.trim().length < 2}>
                    {searching ? "Searching…" : "Search"}
                  </button>
                </div>
              </form>

              <p className="native-watchlist-search-note">
                Choose the exact title and year. Search results are never saved
                automatically.
              </p>

              <div className="native-watchlist-results" aria-live="polite">
                {searchComplete && candidates.length === 0 && (
                  <div className="native-watchlist-empty">
                    No films matched that search.
                  </div>
                )}

                {candidates.map((candidate) => (
                  <SearchCandidate
                    key={candidate.tmdbId}
                    candidate={candidate}
                    saved={savedTmdbIds.has(candidate.tmdbId)}
                    saving={savingTmdbIds.has(candidate.tmdbId)}
                    onAdd={handleAdd}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
