import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DEFAULT_DATE_TIME_FILTER,
  dateTimeFilterLabel,
  getLondonTodayKey,
  isDefaultDateTimeFilter,
  isValidDateTimeFilter,
  normaliseDateTimeFilter,
} from "./dateTimeFilter.js";
import "./DateTimeFilter.css";

function ChevronIcon() {
  return (
    <svg
      className="date-time-filter-chevron"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path fill="currentColor" d="M2 4l4 4 4-4" />
    </svg>
  );
}

function filtersMatch(firstValue, secondValue) {
  const first = normaliseDateTimeFilter(firstValue);
  const second = normaliseDateTimeFilter(secondValue);

  return (
    first.datePreset === second.datePreset &&
    first.customDate === second.customDate &&
    first.timeFrom === second.timeFrom &&
    first.timeTo === second.timeTo
  );
}

export default function DateTimeFilter({
  value,
  onApply,
  disabled = false,
}) {
  const appliedFilter = useMemo(
    () => normaliseDateTimeFilter(value),
    [value]
  );

  const [isOpen, setIsOpen] = useState(false);
  const [draftFilter, setDraftFilter] = useState(appliedFilter);

  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const panelId = useId();
  const headingId = useId();
  const datePresetId = useId();
  const customDateId = useId();
  const timeRangeId = useId();
  const timeFromId = useId();
  const timeToId = useId();
  const timeRangeErrorId = useId();

  const todayKey = getLondonTodayKey();
  const triggerLabel = dateTimeFilterLabel(appliedFilter);
  const filterIsActive = !isDefaultDateTimeFilter(appliedFilter);
  const draftIsDefault = isDefaultDateTimeFilter(draftFilter);
  const draftIsValid = isValidDateTimeFilter(draftFilter);
  const hasPendingChanges = !filtersMatch(appliedFilter, draftFilter);

  const timeRangeIsInvalid =
    Boolean(draftFilter.timeFrom) &&
    Boolean(draftFilter.timeTo) &&
    draftFilter.timeFrom > draftFilter.timeTo;

  useEffect(() => {
    setDraftFilter(normaliseDateTimeFilter(value));
  }, [value]);

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
    if (disabled) {
      setIsOpen(false);
    }
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

  const handleDatePresetChange = (event) => {
    const nextDatePreset = event.target.value;

    setDraftFilter((current) => ({
      ...current,
      datePreset: nextDatePreset,
      customDate:
        nextDatePreset === "custom" && !current.customDate
          ? todayKey
          : current.customDate,
    }));
  };

  const handleCustomDateChange = (event) => {
    setDraftFilter((current) => ({
      ...current,
      customDate: event.target.value,
    }));
  };

  const handleTimeChange = (fieldName) => (event) => {
    setDraftFilter((current) => ({
      ...current,
      [fieldName]: event.target.value,
    }));
  };

  const handleReset = () => {
    setDraftFilter({
      ...DEFAULT_DATE_TIME_FILTER,
    });
  };

  const handleApply = () => {
    if (!hasPendingChanges || !draftIsValid) return;

    onApply(normaliseDateTimeFilter(draftFilter));
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      className="date-time-filter"
      ref={containerRef}
      onKeyDown={handleContainerKeyDown}
    >
      <button
        ref={triggerRef}
        className={`date-time-filter-trigger${
          filterIsActive ? " is-filtered" : ""
        }`}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={`Date and time filter: ${triggerLabel}`}
        disabled={disabled}
        onClick={handleTriggerClick}
      >
        <span className="date-time-filter-trigger-label">
          {triggerLabel}
        </span>

        <ChevronIcon />
      </button>

      {isOpen && (
        <div
          id={panelId}
          className="date-time-filter-panel"
          role="dialog"
          aria-labelledby={headingId}
        >
          <div className="date-time-filter-header">
            <h2 id={headingId} className="date-time-filter-heading">
              Date &amp; Time
            </h2>

            <button
              className="date-time-filter-reset"
              type="button"
              disabled={draftIsDefault}
              onClick={handleReset}
            >
              Reset
            </button>
          </div>

          <div className="date-time-filter-fields">
            <label
              className="date-time-filter-field"
              htmlFor={datePresetId}
            >
              <span className="date-time-filter-label">Date</span>

              <select
                id={datePresetId}
                className="date-time-filter-select"
                value={draftFilter.datePreset}
                onChange={handleDatePresetChange}
              >
                <option value="all">Any date</option>
                <option value="today">Today</option>
                <option value="tomorrow">Tomorrow</option>
                <option value="weekend">This weekend</option>
                <option value="next7">Next 7 days</option>
                <option value="custom">Custom date</option>
              </select>
            </label>

            {draftFilter.datePreset === "custom" && (
              <label
                className="date-time-filter-field"
                htmlFor={customDateId}
              >
                <span className="date-time-filter-label">
                  Choose date
                </span>

                <input
                  id={customDateId}
                  className="date-time-filter-date"
                  type="date"
                  min={todayKey}
                  value={draftFilter.customDate}
                  onChange={handleCustomDateChange}
                />

                {!draftFilter.customDate && (
                  <p
                    className="date-time-filter-error"
                    role="status"
                  >
                    Choose a date before applying this filter.
                  </p>
                )}
              </label>
            )}

            <div
              className="date-time-filter-field"
              role="group"
              aria-labelledby={timeRangeId}
            >
              <span
                id={timeRangeId}
                className="date-time-filter-label"
              >
                Time range
              </span>

              <div className="date-time-filter-time-range">
                <label
                  className="date-time-filter-time-field"
                  htmlFor={timeFromId}
                >
                  <span className="date-time-filter-time-label">
                    From
                  </span>

                  <input
                    id={timeFromId}
                    className="date-time-filter-time"
                    type="time"
                    step="60"
                    value={draftFilter.timeFrom}
                    aria-invalid={timeRangeIsInvalid}
                    aria-describedby={
                      timeRangeIsInvalid ? timeRangeErrorId : undefined
                    }
                    onChange={handleTimeChange("timeFrom")}
                  />
                </label>

                <label
                  className="date-time-filter-time-field"
                  htmlFor={timeToId}
                >
                  <span className="date-time-filter-time-label">
                    To
                  </span>

                  <input
                    id={timeToId}
                    className="date-time-filter-time"
                    type="time"
                    step="60"
                    value={draftFilter.timeTo}
                    aria-invalid={timeRangeIsInvalid}
                    aria-describedby={
                      timeRangeIsInvalid ? timeRangeErrorId : undefined
                    }
                    onChange={handleTimeChange("timeTo")}
                  />
                </label>
              </div>

              {timeRangeIsInvalid && (
                <p
                  id={timeRangeErrorId}
                  className="date-time-filter-error"
                  role="alert"
                >
                  From must be earlier than or equal to To.
                </p>
              )}
            </div>

            <p className="date-time-filter-help">
              Screening dates and times use the Europe/London time zone.
            </p>
          </div>

          <div className="date-time-filter-footer">
            <button
              className="date-time-filter-apply"
              type="button"
              disabled={!hasPendingChanges || !draftIsValid}
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