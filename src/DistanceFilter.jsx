import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DEFAULT_DISTANCE_FILTER,
  buildCinemaDistanceData,
  isDistanceFilterActive,
  normaliseDistanceFilter,
} from "./distanceFilter.js";
import { geocodeUkLocation, geolocationErrorMessage } from "./geocoding.js";
import "./DistanceFilter.css";

function ChevronIcon() {
  return (
    <svg className="distance-filter-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path fill="currentColor" d="M2 4l4 4 4-4" />
    </svg>
  );
}

export default function DistanceFilter({
  value,
  onApply,
  cinemas,
  cinemaLocations,
  locationsStatus,
  locationsError,
  disabled = false,
}) {
  const appliedFilter = useMemo(() => normaliseDistanceFilter(value), [value]);
  const [draftFilter, setDraftFilter] = useState(appliedFilter);
  const [isOpen, setIsOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [lookupStatus, setLookupStatus] = useState("idle");
  const [lookupError, setLookupError] = useState("");
  const [locationChoices, setLocationChoices] = useState([]);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const lookupAbortRef = useRef(null);
  const panelId = useId();
  const headingId = useId();
  const addressId = useId();

  const appliedActive = isDistanceFilterActive(appliedFilter);
  const distanceData = useMemo(
    () => buildCinemaDistanceData(draftFilter.origin, cinemas, cinemaLocations),
    [draftFilter.origin, cinemas, cinemaLocations]
  );
  const selectedOption = distanceData.options.find(
    (option) => option.thresholdMiles === draftFilter.maxMiles
  );
  const draftComparable = normaliseDistanceFilter(draftFilter);
  const hasPendingChanges =
    JSON.stringify(draftComparable) !== JSON.stringify(appliedFilter);
  const canApply =
    hasPendingChanges &&
    (!draftFilter.origin || Boolean(selectedOption)) &&
    locationsStatus !== "loading";

  useEffect(() => setDraftFilter(appliedFilter), [appliedFilter]);

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

  useEffect(() => () => lookupAbortRef.current?.abort(), []);

  const chooseOrigin = (origin) => {
    setDraftFilter({ origin, maxMiles: null, maxLabel: null });
    setLocationChoices([]);
    setLookupError("");
  };

  const handleCurrentLocation = () => {
    setLookupError("");
    setLocationChoices([]);

    if (!navigator.geolocation) {
      setLookupError("Browser location is not available. Enter a postcode or address instead.");
      return;
    }

    setLookupStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        chooseOrigin({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          label: "Current location",
          source: "device",
        });
        setLookupStatus("idle");
      },
      (error) => {
        setLookupStatus("idle");
        setLookupError(geolocationErrorMessage(error));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 300000 }
    );
  };

  const handleAddressSubmit = async (event) => {
    event.preventDefault();
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;
    setLookupStatus("searching");
    setLookupError("");
    setLocationChoices([]);

    try {
      const results = await geocodeUkLocation(address, { signal: controller.signal });
      if (results.length === 0) {
        setLookupError("No UK location was found. Check the postcode or try a more specific address.");
      } else if (results.length === 1) {
        const result = results[0];
        chooseOrigin({ ...result, source: "address" });
      } else {
        setLocationChoices(results);
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        setLookupError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (lookupAbortRef.current === controller) {
        setLookupStatus("idle");
      }
    }
  };

  const handleDistanceChange = (event) => {
    const option = distanceData.options[Number(event.target.value)];
    setDraftFilter((current) => ({
      ...current,
      maxMiles: option?.thresholdMiles ?? null,
      maxLabel: option?.label ?? null,
    }));
  };

  const handleReset = () => {
    lookupAbortRef.current?.abort();
    setDraftFilter({ ...DEFAULT_DISTANCE_FILTER });
    setAddress("");
    setLocationChoices([]);
    setLookupError("");
    setLookupStatus("idle");
  };

  const handleApply = () => {
    if (!canApply) return;
    onApply(normaliseDistanceFilter(draftFilter));
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event) => {
    if (event.key !== "Escape" || !isOpen) return;
    event.preventDefault();
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="distance-filter" ref={containerRef} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        className={`distance-filter-trigger${appliedActive ? " is-filtered" : ""}`}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => !disabled && setIsOpen((current) => !current)}
      >
        <span className="distance-filter-trigger-label">
          {appliedActive ? `Distance · ${appliedFilter.maxLabel}` : "Distance"}
        </span>
        <ChevronIcon />
      </button>

      {isOpen && (
        <div id={panelId} className="distance-filter-panel" role="dialog" aria-labelledby={headingId}>
          <div className="distance-filter-header">
            <h2 id={headingId} className="distance-filter-heading">Distance</h2>
            <button
              className="distance-filter-reset"
              type="button"
              disabled={!draftFilter.origin && !appliedActive}
              onClick={handleReset}
            >
              Reset
            </button>
          </div>

          <div className="distance-filter-body">
            <p className="distance-filter-intro">Choose where your journey starts.</p>

            <button
              className="distance-filter-location-button"
              type="button"
              disabled={lookupStatus !== "idle"}
              onClick={handleCurrentLocation}
            >
              {lookupStatus === "locating" ? "Finding location…" : "Use my current location"}
            </button>

            <div className="distance-filter-divider"><span>or</span></div>

            <form className="distance-filter-address-form" onSubmit={handleAddressSubmit}>
              <label htmlFor={addressId}>UK postcode or address</label>
              <div className="distance-filter-address-row">
                <input
                  id={addressId}
                  type="search"
                  value={address}
                  maxLength={200}
                  autoComplete="postal-code"
                  placeholder="e.g. SE1 8XX"
                  onChange={(event) => setAddress(event.target.value)}
                />
                <button type="submit" disabled={lookupStatus !== "idle" || address.trim().length < 3}>
                  {lookupStatus === "searching" ? "Finding…" : "Find"}
                </button>
              </div>
            </form>

            {lookupError && <p className="distance-filter-error" role="status">{lookupError}</p>}

            {locationChoices.length > 0 && (
              <div className="distance-filter-choices" aria-label="Choose a location">
                <p>Choose the correct location:</p>
                {locationChoices.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    onClick={() => chooseOrigin({ ...choice, source: "address" })}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            )}

            {draftFilter.origin && (
              <div className="distance-filter-resolved">
                <p><strong>Starting from:</strong> {draftFilter.origin.label}</p>

                {locationsStatus === "loading" && <p>Loading cinema locations…</p>}
                {locationsStatus === "error" && (
                  <p className="distance-filter-error" role="status">
                    Cinema locations are unavailable. {locationsError}
                  </p>
                )}
                {locationsStatus === "ready" && distanceData.options.length > 0 && (
                  <label className="distance-filter-distance-field">
                    <span>Maximum distance</span>
                    <select
                      value={selectedOption ? String(distanceData.options.indexOf(selectedOption)) : ""}
                      onChange={handleDistanceChange}
                    >
                      <option value="">Choose distance…</option>
                      {distanceData.options.map((option, index) => (
                        <option key={option.label} value={index}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {locationsStatus === "ready" && distanceData.options.length === 0 && (
                  <p className="distance-filter-error">No cinema coordinates are available.</p>
                )}
                {distanceData.missingCinemaNames.length > 0 && (
                  <p className="distance-filter-note">
                    {distanceData.missingCinemaNames.length} cinema{distanceData.missingCinemaNames.length === 1 ? " is" : "s are"} unavailable for distance filtering and will be excluded.
                  </p>
                )}
              </div>
            )}

            <p className="distance-filter-privacy">
              Your chosen location stays in this browser session. An address is sent only when you press Find. Search by{" "}
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>.
            </p>
          </div>

          <div className="distance-filter-footer">
            <button className="distance-filter-apply" type="button" disabled={!canApply} onClick={handleApply}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
