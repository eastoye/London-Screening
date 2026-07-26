import { useEffect, useId, useRef, useState } from "react";
import "./FiltersDropdown.css";

function ChevronIcon() {
  return (
    <svg
      className="filters-dropdown-chevron"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path fill="currentColor" d="M2 4l4 4 4-4" />
    </svg>
  );
}

export default function FiltersDropdown({
  watchlistOnly,
  onApply,
  isConnected,
  watchlistStatus,
  watchlistError,
  watchlistCount = 0,
  disabled = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [draftWatchlistOnly, setDraftWatchlistOnly] =
    useState(Boolean(watchlistOnly));

  const containerRef = useRef(null);
  const triggerRef = useRef(null);

  const panelId = useId();
  const headingId = useId();
  const watchlistOptionId = useId();
  const watchlistStatusId = useId();

  const watchlistAvailable =
    isConnected && watchlistStatus === "ready";

  const hasPendingChanges =
    draftWatchlistOnly !== Boolean(watchlistOnly);

  const canApply =
    hasPendingChanges &&
    (!draftWatchlistOnly || watchlistAvailable);

  let watchlistStatusMessage = "";
  let watchlistStatusIsError = false;

  if (!isConnected) {
    watchlistStatusMessage =
      "Connect Trakt to use your movie watchlist.";
  } else if (
    watchlistStatus === "loading" ||
    watchlistStatus === "idle"
  ) {
    watchlistStatusMessage =
      "Loading your Trakt movie watchlist…";
  } else if (watchlistStatus === "error") {
    watchlistStatusMessage =
      watchlistError ||
      "Your Trakt watchlist is currently unavailable.";
    watchlistStatusIsError = true;
  } else {
    watchlistStatusMessage = `${watchlistCount} movie${
      watchlistCount === 1 ? "" : "s"
    } loaded from your watchlist.`;
  }

  useEffect(() => {
    setDraftWatchlistOnly(Boolean(watchlistOnly));
  }, [watchlistOnly]);

  useEffect(() => {
    if (!isConnected && !watchlistOnly) {
      setDraftWatchlistOnly(false);
    }
  }, [isConnected, watchlistOnly]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleFocusIn = (event) => {
      if (!containerRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener(
      "pointerdown",
      handlePointerDown
    );
    document.addEventListener(
      "focusin",
      handleFocusIn
    );

    return () => {
      document.removeEventListener(
        "pointerdown",
        handlePointerDown
      );
      document.removeEventListener(
        "focusin",
        handleFocusIn
      );
    };
  }, [isOpen]);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  const handleContainerKeyDown = (event) => {
    if (event.key !== "Escape" || !isOpen) {
      return;
    }

    event.preventDefault();
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerClick = () => {
    if (disabled) return;

    setIsOpen((current) => !current);
  };

  const handleWatchlistChange = (event) => {
    if (!watchlistAvailable) return;

    setDraftWatchlistOnly(event.target.checked);
  };

  const handleReset = () => {
    setDraftWatchlistOnly(false);
  };

  const handleApply = () => {
    if (!canApply) return;

    onApply(draftWatchlistOnly);
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      className="filters-dropdown"
      ref={containerRef}
      onKeyDown={handleContainerKeyDown}
    >
      <button
        ref={triggerRef}
        className={`filters-dropdown-trigger${
          watchlistOnly ? " is-filtered" : ""
        }`}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={`Filters. ${
          watchlistOnly
            ? "1 filter currently active."
            : "No filters currently active."
        }`}
        disabled={disabled}
        onClick={handleTriggerClick}
      >
        <span className="filters-dropdown-trigger-content">
          <span className="filters-dropdown-trigger-label">
            Filters
          </span>

          {watchlistOnly && (
            <span
              className="filters-dropdown-count"
              aria-hidden="true"
            >
              1
            </span>
          )}
        </span>

        <ChevronIcon />
      </button>

      {isOpen && (
        <div
          id={panelId}
          className="filters-dropdown-panel"
          role="dialog"
          aria-labelledby={headingId}
        >
          <div className="filters-dropdown-header">
            <h2
              id={headingId}
              className="filters-dropdown-heading"
            >
              Filters
            </h2>

            <button
              className="filters-dropdown-reset"
              type="button"
              disabled={!draftWatchlistOnly}
              onClick={handleReset}
            >
              Reset
            </button>
          </div>

          <div
            className="filters-dropdown-options"
            role="group"
            aria-label="Additional screening filters"
          >
            <label
              className={`filters-dropdown-option${
                watchlistAvailable ? "" : " is-disabled"
              }`}
              htmlFor={watchlistOptionId}
            >
              <input
                id={watchlistOptionId}
                type="checkbox"
                checked={draftWatchlistOnly}
                disabled={!watchlistAvailable}
                aria-describedby={watchlistStatusId}
                onChange={handleWatchlistChange}
              />

              <span className="filters-dropdown-option-copy">
                <span className="filters-dropdown-option-title">
                  On my watchlist
                </span>

                <span className="filters-dropdown-option-description">
                  Only show films on your Trakt movie
                  watchlist.
                </span>
              </span>
            </label>
          </div>

          <p
            id={watchlistStatusId}
            className={`filters-dropdown-status${
              watchlistStatusIsError ? " error" : ""
            }`}
            role={watchlistStatusIsError ? "status" : undefined}
          >
            {watchlistStatusMessage}
          </p>

          <div className="filters-dropdown-footer">
            <button
              className="filters-dropdown-apply"
              type="button"
              disabled={!canApply}
              onClick={handleApply}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}