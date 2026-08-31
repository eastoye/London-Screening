import test from "node:test";
import assert from "node:assert/strict";
import { parseCsvInput, parseCsvRows } from "./csvParser.js";

test("parses quoted CSV fields containing commas", () => {
  const rows = parseCsvRows('Name,Year\n"Paris, Texas",1984\n');
  assert.deepEqual(rows, [["Name", "Year"], ["Paris, Texas", "1984"]]);
});

test("parses Letterboxd ratings and converts them to Trakt scale", () => {
  const [record] = parseCsvInput(
    "Date,Name,Year,Letterboxd URI,Rating\n2026-01-01,Alien,1979,https://letterboxd.com/film/alien/,4.5",
    { filename: "ratings.csv" }
  );

  assert.equal(record.source, "letterboxd");
  assert.equal(record.rating, 9);
  assert.equal(record.watchlist, false);
});

test("parses IMDb watchlist IDs but ignores the community IMDb rating", () => {
  const [record] = parseCsvInput(
    "Const,Title,IMDb Rating,Year\ntt0113277,Heat,8.3,1995",
    { filename: "imdb-watchlist.csv" }
  );

  assert.equal(record.source, "imdb");
  assert.equal(record.imdbId, "tt0113277");
  assert.equal(record.rating, null);
  assert.equal(record.watchlist, true);
});

test("parses the user's IMDb rating", () => {
  const [record] = parseCsvInput(
    "Const,Your Rating,Title,Year\ntt0078748,9,Alien,1979",
    { filename: "ratings.csv" }
  );

  assert.equal(record.rating, 9);
  assert.equal(record.watchlist, false);
});
