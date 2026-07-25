import { useEffect, useId, useMemo, useRef, useState } from "react";
import "./CinemaMultiSelect.css";

function SearchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      className="cinema-multiselect-chevron"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path fill="currentColor" d="M2 4l4 4 4-4" />
    </svg>
  );
}

export default function CinemaMultiSelect({
  cinemas,
  selectedCinemas,
  onToggleCinema,
  onSelectAll,
  onClearAll,
  disabled = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [cinemaSearch, setCinemaSearch] = useState("");
  const [draftSelection, setDraftSelection] = useState(
    () => new Set(selectedCinemas)
  );

  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const panelId = useId();
  const searchInputId = useId();

  useEffect(() => {
    setDraftSelection(
      new Set(
        cinemas.filter((cinemaName) => selectedCinemas.has(cinemaName))
      )
    );
  }, [cinemas, selectedCinemas]);

  const appliedSelectedCount = useMemo(
    () =>
      cinemas.reduce(
        (count, cinemaName) =>
          selectedCinemas.has(cinemaName) ? count + 1 : count,
        0
      ),
    [cinemas, selectedCinemas]
  );

  const draftSelectedCount = useMemo(
    () =>
      cinemas.reduce(
        (count, cinemaName) =>
          draftSelection.has(cinemaName) ? count + 1 : count,
        0
      ),
    [cinemas, draftSelection]
  );

  const totalCount = cinemas.length;

  const appliedAllSelected =
    totalCount > 0 && appliedSelectedCount === totalCount;

  const draftAllSelected =
    totalCount > 0 && draftSelectedCount === totalCount;

  const selectionIsFiltered = appliedSelectedCount < totalCount;

  const hasPendingChanges = useMemo(() => {
    if (appliedSelectedCount !== draftSelectedCount) {
      return true;
    }

    return cinemas.some(
      (cinemaName) =>
        selectedCinemas.has(cinemaName) !==
        draftSelection.has(cinemaName)
    );
  }, [
    cinemas,
    selectedCinemas,
    draftSelection,
    appliedSelectedCount,
    draftSelectedCount,
  ]);

  const visibleCinemas = useMemo(() => {
    const query = cinemaSearch.trim().toLowerCase();

    if (!query) return cinemas;

    return cinemas.filter((cinemaName) =>
      cinemaName.toLowerCase().includes(query)
    );
  }, [cinemas, cinemaSearch]);

  let triggerLabel = "All cinemas";

  if (totalCount === 0) {
    triggerLabel = "Cinemas";
  } else if (appliedSelectedCount === 0) {
    triggerLabel = "No cinemas";
  } else if (!appliedAllSelected) {
    triggerLabel = `${appliedSelectedCount} of ${totalCount} cinemas`;
  }

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

  const handleContainerKeyDown = (event) => {
    if (event.key !== "Escape" || !isOpen) return;

    event.preventDefault();
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerClick = () => {
    if (disabled) return;
    setIsOpen((current) => !current);
  };

  const handleDraftToggle = (cinemaName) => {
    setDraftSelection((currentSelection) => {
      const nextSelection = new Set(currentSelection);

      if (nextSelection.has(cinemaName)) {
        nextSelection.delete(cinemaName);
      } else {
        nextSelection.add(cinemaName);
      }

      return nextSelection;
    });
  };

  const handleDraftSelectAll = () => {
    setDraftSelection(new Set(cinemas));
  };

  const handleDraftClearAll = () => {
    setDraftSelection(new Set());
  };

  const handleApply = () => {
    if (!hasPendingChanges) return;

    if (draftSelectedCount === totalCount) {
      onSelectAll();
    } else if (draftSelectedCount === 0) {
      onClearAll();
    } else {
      for (const cinemaName of cinemas) {
        const currentlySelected = selectedCinemas.has(cinemaName);
        const shouldBeSelected = draftSelection.has(cinemaName);

        if (currentlySelected !== shouldBeSelected) {
          onToggleCinema(cinemaName);
        }
      }
    }

    setIsOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      className="cinema-multiselect"
      ref={containerRef}
      onKeyDown={handleContainerKeyDown}
    >
      <button
        ref={triggerRef}
        className={`cinema-multiselect-trigger${
          selectionIsFiltered ? " is-filtered" : ""
        }`}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={`${triggerLabel}. ${appliedSelectedCount} of ${totalCount} cinemas currently applied.`}
        disabled={disabled}
        onClick={handleTriggerClick}
      >
        <span className="cinema-multiselect-trigger-label">
          {triggerLabel}
        </span>

        <ChevronIcon />
      </button>

      {isOpen && (
        <div
          id={panelId}
          className="cinema-multiselect-panel"
          role="dialog"
          aria-label="Choose cinemas"
        >
          <div className="cinema-multiselect-header">
            <span
              className="cinema-multiselect-count"
              aria-live="polite"
              aria-atomic="true"
            >
              {draftSelectedCount} of {totalCount} selected
            </span>

            <div
              className="cinema-multiselect-actions"
              aria-label="Cinema selection actions"
            >
              <button
                className="cinema-multiselect-action"
                type="button"
                disabled={draftAllSelected || totalCount === 0}
                onClick={handleDraftSelectAll}
              >
                Select All
              </button>

              <button
                className="cinema-multiselect-action"
                type="button"
                disabled={draftSelectedCount === 0}
                onClick={handleDraftClearAll}
              >
                Clear All
              </button>
            </div>
          </div>

          <label
            className="cinema-multiselect-search"
            htmlFor={searchInputId}
          >
            <span
              className="cinema-multiselect-search-icon"
              aria-hidden="true"
            >
              <SearchIcon />
            </span>

            <input
              id={searchInputId}
              type="search"
              value={cinemaSearch}
              placeholder="Search cinemas…"
              aria-label="Search cinema names"
              onChange={(event) => setCinemaSearch(event.target.value)}
            />
          </label>

          <div
            className="cinema-multiselect-options"
            role="group"
            aria-label="Cinema choices"
          >
            {visibleCinemas.length > 0 ? (
              visibleCinemas.map((cinemaName) => {
                const checked = draftSelection.has(cinemaName);

                return (
                  <label
                    className="cinema-multiselect-option"
                    key={cinemaName}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleDraftToggle(cinemaName)}
                    />

                    <span className="cinema-multiselect-option-text">
                      {cinemaName}
                    </span>
                  </label>
                );
              })
            ) : (
              <p className="cinema-multiselect-empty">
                No cinema names match your search.
              </p>
            )}
          </div>

          <div className="cinema-multiselect-footer">
            <button
              className="cinema-multiselect-apply"
              type="button"
              disabled={!hasPendingChanges}
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