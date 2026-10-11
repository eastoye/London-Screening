import assert from "node:assert/strict";
import test from "node:test";
import { confirmedForDestination, initialiseDestinationSelections, recordSelection } from "./destinations.js";
import { parseTextInput } from "./textParser.js";
import { deduplicateBeforeMatching } from "./model.js";

const matched = (record, id) => ({ ...record, status: "matched", match: { tmdbId: id }, selectedTmdbId: id });
test("native excludes rated-only rows by default and permits deliberate inclusion", () => {
  const records = initialiseDestinationSelections(parseTextInput("Alien\nHeat (1995), 9/10").map((r, i) => matched(r, 348 + i)));
  assert.deepEqual(confirmedForDestination(records, "native").map((r) => r.selectedTmdbId), [348]);
  records[1].nativeIncluded = true; records[1].nativeSelectedTmdbId = 349;
  assert.equal(confirmedForDestination(records, "native").length, 2);
  assert.equal(confirmedForDestination(records, "trakt").length, 2);
});
test("destinations retain independent skip and selection decisions", () => {
  const [record] = initialiseDestinationSelections([matched(parseTextInput("Alien")[0], 348)]);
  record.nativeSelectedTmdbId = null;
  assert.equal(recordSelection(record, "native"), null);
  assert.equal(recordSelection(record, "trakt"), 348);
});
test("ambiguous films remain unselected until a candidate is explicitly selected", () => {
  const [record] = initialiseDestinationSelections([{ ...parseTextInput("The Killer")[0], status: "ambiguous", candidates: [{ tmdbId: 1 }, { tmdbId: 2 }] }]);
  assert.deepEqual(confirmedForDestination([record], "native"), []);
  record.nativeSelectedTmdbId = 2;
  assert.equal(confirmedForDestination([record], "native")[0].selectedTmdbId, 2);
  record.nativeSelectedTmdbId = 999;
  assert.deepEqual(confirmedForDestination([record], "native"), []);
});
test("native identity remains importable despite conflicting ratings; Trakt skips them", () => {
  const [record] = deduplicateBeforeMatching(parseTextInput("Alien (1979)\nAlien (1979), 8/10\nAlien (1979), 9/10"));
  const records = initialiseDestinationSelections([matched(record, 348)]);
  assert.equal(confirmedForDestination(records, "native").length, 1);
  assert.equal(confirmedForDestination(records, "trakt").length, 0);
});
test("duplicate exact identities merge while films with the same title remain distinct", () => {
  const records = initialiseDestinationSelections([1, 1, 2].map((id) => matched(parseTextInput("The Killer")[0], id)));
  assert.equal(confirmedForDestination(records, "native").length, 2);
});
test("unresolved films cannot be forced into confirmation", () => {
  const record = { ...parseTextInput("Alien")[0], status: "unmatched", nativeSelectedTmdbId: 348, match: { tmdbId: 348 } };
  assert.equal(confirmedForDestination([record], "native").length, 0);
});
