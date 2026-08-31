import test from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { parseImportFile } from "./fileParser.js";

test("parses an IMDb CSV upload", async () => {
  const file = new File(
    ["Const,Title,Year\ntt0113277,Heat,1995"],
    "imdb-watchlist.csv",
    { type: "text/csv" }
  );
  const [record] = await parseImportFile(file);

  assert.equal(record.imdbId, "tt0113277");
  assert.equal(record.watchlist, true);
});

test("parses watchlist and ratings from a Letterboxd export ZIP", async () => {
  const archive = zipSync({
    "letterboxd/watchlist.csv": strToU8(
      "Date,Name,Year,Letterboxd URI\n2026-01-01,Alien,1979,https://letterboxd.com/film/alien/"
    ),
    "letterboxd/ratings.csv": strToU8(
      "Date,Name,Year,Letterboxd URI,Rating\n2026-01-02,Heat,1995,https://letterboxd.com/film/heat-1995/,5"
    ),
  });
  const file = new File([archive], "letterboxd-export.zip", {
    type: "application/zip",
  });
  const records = await parseImportFile(file);

  assert.equal(records.length, 2);
  assert.equal(records[0].watchlist, true);
  assert.equal(records[1].rating, 10);
});
