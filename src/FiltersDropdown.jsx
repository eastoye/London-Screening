import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  FORMAT_OPTIONS,
  GENRE_OPTIONS,
  UK_CERTIFICATION_OPTIONS,
  countScreeningFilters,
  normaliseScreeningFilters,
} from "./screeningFilters.js";
import "./FiltersDropdown.css";

function ChevronIcon() {
  return (
    <svg className="filters-dropdown-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path fill="currentColor" d="M2 4l4 4 4-4" />
    </svg>
  );
}

function MultiSelectGroup({ legend, options, selected, onToggle }) {
  return (
    <fieldset className="filters-dropdown-group">
      <legend>{legend}</legend>
      <div className="filters-dropdown-grid">
        {options.map((option) => {
          const value = typeof option === "string" ? option : option.value;
          const label = typeof option === "string" ? option : option.label;
          return (
            <label className="filters-dropdown-chip" key={value}>
              <input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} />
              <span>{label === "Science Fiction" ? "Sci-Fi" : label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function toggleSelection(values, value) {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

export default function FiltersDropdown({
  value,
  onApply,
  isConnected,
  watchlistStatus,
  watchlistError,
  watchlistCount = 0,
  disabled = false,
}) {
  const appliedFilters = useMemo(() => normaliseScreeningFilters(value), [value]);
  const [isOpen, setIsOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState(appliedFilters);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const panelId = useId();
  const headingId = useId();
  const watchlistOptionId = useId();
  const watchlistStatusId = useId();

  const watchlistAvailable = isConnected && watchlistStatus === "ready";
  const activeFilterCount = countScreeningFilters(appliedFilters);
  const draftFilterCount = countScreeningFilters(draftFilters);
  const hasPendingChanges = JSON.stringify(draftFilters) !== JSON.stringify(appliedFilters);
  const canApply = hasPendingChanges && (!draftFilters.watchlistOnly || watchlistAvailable);

  let watchlistStatusMessage = "";
  let watchlistStatusIsError = false;
  if (!isConnected) {
    watchlistStatusMessage = "Connect Trakt to use your movie watchlist.";
  } else if (watchlistStatus === "loading" || watchlistStatus === "idle") {
    watchlistStatusMessage = "Loading your Trakt movie watchlist…";
  } else if (watchlistStatus === "error") {
    watchlistStatusMessage = watchlistError || "Your Trakt watchlist is currently unavailable.";
    watchlistStatusIsError = true;
  } else {
    watchlistStatusMessage = `${watchlistCount} movie${watchlistCount === 1 ? "" : "s"} loaded from your watchlist.`;
  }

  useEffect(() => setDraftFilters(appliedFilters), [appliedFilters]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handlePointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setIsOpen(false);
    };
    const handleFocusIn = (event) => {
      if (!containerRef.current?.contains(event.target)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [isOpen]);

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  const updateDraft = (changes) => setDraftFilters((current) => ({ ...current, ...changes }));
  const handleContainerKeyDown = (event) => {
    if (event.key !== "Escape" || !isOpen) return;
    event.preventDefault();
    setIsOpen(false);
    triggerRef.current?.focus();
  };
  const handleWatchlistChange = (event) => {
    if (event.target.checked && !watchlistAvailable) return;
    updateDraft({ watchlistOnly: event.target.checked });
  };
  const handleReset = () => setDraftFilters(normaliseScreeningFilters());
  const handleApply = () => {
    if (!canApply) return;
    onApply(normaliseScreeningFilters(draftFilters));
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="filters-dropdown" ref={containerRef} onKeyDown={handleContainerKeyDown}>
      <button
        ref={triggerRef}
        className={`filters-dropdown-trigger${activeFilterCount > 0 ? " is-filtered" : ""}`}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={`Filters. ${activeFilterCount} active.`}
        disabled={disabled}
        onClick={() => !disabled && setIsOpen((current) => !current)}
      >
        <span className="filters-dropdown-trigger-content">
          <span className="filters-dropdown-trigger-label">Filters</span>
          {activeFilterCount > 0 && <span className="filters-dropdown-count" aria-hidden="true">{activeFilterCount}</span>}
        </span>
        <ChevronIcon />
      </button>

      {isOpen && (
        <div id={panelId} className="filters-dropdown-panel" role="dialog" aria-labelledby={headingId}>
          <div className="filters-dropdown-header">
            <h2 id={headingId} className="filters-dropdown-heading">Filters</h2>
            <button className="filters-dropdown-reset" type="button" disabled={draftFilterCount === 0} onClick={handleReset}>Reset</button>
          </div>

          <div className="filters-dropdown-scroll">
            <div className="filters-dropdown-options">
              <label className={`filters-dropdown-option${watchlistAvailable || draftFilters.watchlistOnly ? "" : " is-disabled"}`} htmlFor={watchlistOptionId}>
                <input
                  id={watchlistOptionId}
                  type="checkbox"
                  checked={draftFilters.watchlistOnly}
                  disabled={!watchlistAvailable && !draftFilters.watchlistOnly}
                  aria-describedby={watchlistStatusId}
                  onChange={handleWatchlistChange}
                />
                <span className="filters-dropdown-option-copy">
                  <span className="filters-dropdown-option-title">On my watchlist</span>
                  <span className="filters-dropdown-option-description">Show films from your Trakt watchlist.</span>
                </span>
              </label>
            </div>

            <p id={watchlistStatusId} className={`filters-dropdown-status${watchlistStatusIsError ? " error" : ""}`} role={watchlistStatusIsError ? "status" : undefined}>
              {watchlistStatusMessage}
            </p>

            <MultiSelectGroup
              legend="Genre"
              options={GENRE_OPTIONS}
              selected={draftFilters.genres}
              onToggle={(genre) => updateDraft({ genres: toggleSelection(draftFilters.genres, genre) })}
            />
            <MultiSelectGroup
              legend="UK age rating"
              options={UK_CERTIFICATION_OPTIONS}
              selected={draftFilters.certifications}
              onToggle={(certification) => updateDraft({ certifications: toggleSelection(draftFilters.certifications, certification) })}
            />
            <MultiSelectGroup
              legend="Format"
              options={FORMAT_OPTIONS}
              selected={draftFilters.formats}
              onToggle={(format) => updateDraft({ formats: toggleSelection(draftFilters.formats, format) })}
            />

            <div className="filters-dropdown-options filters-dropdown-options-last">
              <label className="filters-dropdown-option">
                <input type="checkbox" checked={draftFilters.hideSoldOut} onChange={(event) => updateDraft({ hideSoldOut: event.target.checked })} />
                <span className="filters-dropdown-option-copy">
                  <span className="filters-dropdown-option-title">Hide sold out</span>
                  <span className="filters-dropdown-option-description">Screenings with unknown availability remain visible.</span>
                </span>
              </label>
            </div>
          </div>

          <div className="filters-dropdown-footer">
            <button className="filters-dropdown-apply" type="button" disabled={!canApply} onClick={handleApply}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}
