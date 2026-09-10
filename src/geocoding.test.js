import assert from "node:assert/strict";
import test from "node:test";
import { geocodeUkLocation, geolocationErrorMessage } from "./geocoding.js";

test("short or empty address input is rejected before a network request", async () => {
  await assert.rejects(() => geocodeUkLocation("  "), /postcode or address/i);
});

test("browser geolocation denial has a useful non-blocking fallback", () => {
  assert.match(geolocationErrorMessage({ code: 1 }), /denied/i);
  assert.match(geolocationErrorMessage({ code: 1 }), /postcode or address/i);
});
