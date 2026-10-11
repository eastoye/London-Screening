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

test("text files use the title parser instead of silently dropping the first film", async () => {
  const records = await parseImportFile(new File(["Alien\nHeat (1995)\nParis, Texas"], "films.txt"));
  assert.deepEqual(records.map((r) => r.title), ["Alien", "Heat", "Paris, Texas"]);
});
test("ignores unrelated ZIP files and preserves watchlist films with ratings", async () => {
  const archive = zipSync({
    "watchlist.csv": strToU8("Name,Year,Rating\nAlien,1979,4.5"),
    "ratings.csv": strToU8("Name,Year,Rating\nHeat,1995,5"),
    "unrelated.csv": strToU8("Name,Year\nWrong,2000"),
  });
  const result = await parseImportFile(new File([archive], "letterboxd.zip"));
  assert.equal(result.length, 2); assert.equal(result[0].watchlist, true);
  assert.equal(result[1].watchlist, false);
});
test("enforces compressed file size before reading it", async () => {
  await assert.rejects(parseImportFile({ name: "large.zip", size: 11 * 1024 * 1024, arrayBuffer() { throw new Error("must not read"); } }), /10 MB/);
});
