const DEFAULT_GEOCODER_BASE_URL = "https://nominatim.openstreetmap.org";
let nextRequestAt = 0;

async function waitForRequestSlot(signal) {
  if (signal?.aborted) {
    throw new DOMException("The request was cancelled.", "AbortError");
  }

  const delay = Math.max(0, nextRequestAt - Date.now());

  if (delay > 0) {
    await new Promise((resolve, reject) => {
      const handleAbort = () => {
        globalThis.clearTimeout(timeoutId);
        reject(new DOMException("The request was cancelled.", "AbortError"));
      };
      const timeoutId = globalThis.setTimeout(() => {
        signal?.removeEventListener("abort", handleAbort);
        resolve();
      }, delay);
      signal?.addEventListener("abort", handleAbort, { once: true });
    });
  }

  nextRequestAt = Date.now() + 1100;
}

function geocoderBaseUrl() {
  const configured = import.meta.env?.VITE_GEOCODER_BASE_URL?.trim();
  return (configured || DEFAULT_GEOCODER_BASE_URL).replace(/\/$/, "");
}

export async function geocodeUkLocation(rawQuery, { signal } = {}) {
  const query = rawQuery.trim();

  if (query.length < 3) {
    throw new Error("Enter a UK postcode or address.");
  }

  if (query.length > 200) {
    throw new Error("That address is too long. Try a postcode or shorter address.");
  }

  await waitForRequestSlot(signal);

  const url = new URL(`${geocoderBaseUrl()}/search`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", query);
  url.searchParams.set("countrycodes", "gb");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("dedupe", "1");
  url.searchParams.set("accept-language", "en-GB");

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error("The location service is unavailable. Try again later.");
  }

  const payload = await response.json();

  if (!Array.isArray(payload)) {
    throw new Error("The location service returned an unexpected response.");
  }

  const seen = new Set();
  const results = [];

  for (const result of payload) {
    const latitude = Number(result.lat);
    const longitude = Number(result.lon);
    const countryCode = result.address?.country_code?.toLowerCase();

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      (countryCode && countryCode !== "gb")
    ) {
      continue;
    }

    const key = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      id: result.osm_type && result.osm_id
        ? `${result.osm_type}:${result.osm_id}`
        : String(result.place_id ?? key),
      label: result.display_name || query,
      latitude,
      longitude,
    });
  }

  return results;
}

export function geolocationErrorMessage(error) {
  if (error?.code === 1) {
    return "Location permission was denied. You can enter a postcode or address instead.";
  }
  if (error?.code === 2) {
    return "Your current location could not be determined. Try entering an address.";
  }
  if (error?.code === 3) {
    return "Finding your location took too long. Try again or enter an address.";
  }
  return "Your current location is unavailable. Try entering an address.";
}
