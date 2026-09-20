import assert from "node:assert/strict";
import test from "node:test";
import {
  getScreeningDisplayChips,
  getScreeningFormatValues,
} from "./screeningPresentation.js";

test("generic digital labels are not exposed as user-facing formats", () => {
  assert.deepEqual(getScreeningFormatValues({ format: "Digital Cinema" }), []);
  assert.deepEqual(getScreeningFormatValues({ format: "2D Digital" }), []);
});

test("legacy presentation labels normalise into useful format filters", () => {
  assert.deepEqual(
    getScreeningFormatValues({ format: "4K, Laser" }),
    ["4k"]
  );
  assert.deepEqual(
    getScreeningFormatValues({ format: "Dolby Cinema" }),
    ["dolby_cinema"]
  );
});

test("structured projection values and legacy values are deduplicated", () => {
  assert.deepEqual(
    getScreeningFormatValues({
      projection_formats: ["imax", "70mm"],
      format: "IMAX, 70mm",
    }),
    ["70mm", "imax"]
  );
});

test("ambiguous 35mm slash DCP is displayed but does not claim a 35mm filter match", () => {
  const screening = { format: "35mm / DCP" };

  assert.deepEqual(getScreeningFormatValues(screening), []);
  assert.deepEqual(
    getScreeningDisplayChips(screening).map((chip) => chip.label),
    ["35mm / DCP"]
  );
});

test("display chips combine format accessibility programme and headline event metadata", () => {
  const chips = getScreeningDisplayChips({
    projection_formats: ["35mm"],
    accessibility_features: ["captioned"],
    programme_types: ["members_only"],
    screening_tags: ["q_and_a", "subtitled"],
  });

  assert.deepEqual(
    chips.map((chip) => chip.label),
    ["35mm", "Captioned", "Members only", "Q&A"]
  );
});
