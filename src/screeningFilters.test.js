import assert from "node:assert/strict";
import test from "node:test";
import { screeningMatchesMetadataFilters } from "./screeningFilters.js";

function screening(overrides = {}) {
  return {
    sold_out: false,
    availability_status: "available",
    format: null,
    projection_formats: [],
    accessibility_features: [],
    programme_types: [],
    movies: {
      genres: ["Drama"],
      uk_certification: "15",
      uk_certification_status: "confirmed",
    },
    ...overrides,
  };
}

test("format filtering recognises cleaned legacy presentation values", () => {
  assert.equal(
    screeningMatchesMetadataFilters(screening({ format: "4K, Laser" }), {
      formats: ["4k"],
    }),
    true
  );
});

test("formats use OR within the group and accessibility combines with them using AND", () => {
  const row = screening({
    projection_formats: ["70mm"],
    accessibility_features: ["captioned"],
  });

  assert.equal(
    screeningMatchesMetadataFilters(row, {
      formats: ["35mm", "70mm"],
      accessibility: ["captioned"],
    }),
    true
  );

  assert.equal(
    screeningMatchesMetadataFilters(row, {
      formats: ["35mm", "70mm"],
      accessibility: ["relaxed"],
    }),
    false
  );
});

test("programme type filters match structured programme metadata", () => {
  assert.equal(
    screeningMatchesMetadataFilters(
      screening({ programme_types: ["parent_and_baby"] }),
      { programmeTypes: ["parent_and_baby"] }
    ),
    true
  );
});
