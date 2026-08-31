import test from "node:test";
import assert from "node:assert/strict";
import { parseTextInput } from "./textParser.js";
import { deduplicateBeforeMatching } from "./model.js";

test("parses titles, optional years, and ratings without breaking comma titles", () => {
  const records = parseTextInput(
    "Alien\nHeat (1995)\nParis, Texas\nDune: Part Two, 8/10\nAlien, 1979, 9/10"
  );

  assert.equal(records[0].title, "Alien");
  assert.equal(records[0].watchlist, true);
  assert.deepEqual(
    { title: records[1].title, year: records[1].year },
    { title: "Heat", year: 1995 }
  );
  assert.equal(records[2].title, "Paris, Texas");
  assert.equal(records[2].year, null);
  assert.deepEqual(
    { title: records[3].title, rating: records[3].rating, watchlist: records[3].watchlist },
    { title: "Dune: Part Two", rating: 8, watchlist: false }
  );
  assert.deepEqual(
    { title: records[4].title, year: records[4].year, rating: records[4].rating },
    { title: "Alien", year: 1979, rating: 9 }
  );
});

test("merges duplicate watchlist and rating intentions", () => {
  const records = parseTextInput("Heat (1995)\nHeat (1995), 10/10");
  const [merged] = deduplicateBeforeMatching(records);

  assert.equal(merged.watchlist, true);
  assert.equal(merged.rating, 10);
  assert.equal(merged.duplicateCount, 2);
});

test("converts ratings from a five point scale", () => {
  const [record] = parseTextInput("Alien, 4.5/5");

  assert.equal(record.rating, 9);
  assert.equal(record.originalRating, 4.5);
  assert.equal(record.ratingScale, 5);
});

test("does not silently choose between conflicting duplicate ratings", () => {
  const records = parseTextInput("Alien (1979), 8/10\nAlien (1979), 9/10");
  const [merged] = deduplicateBeforeMatching(records);

  assert.equal(merged.ratingConflict, true);
  assert.match(merged.invalidReason, /different ratings/i);
});
