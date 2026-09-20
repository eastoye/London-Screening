import assert from "node:assert/strict";
import test from "node:test";
import { posterCandidates, posterUrl } from "./posterUrl.js";

test("posterUrl builds the TMDB thumbnail URL", () => {
  assert.equal(
    posterUrl("/abc123.jpg"),
    "https://image.tmdb.org/t/p/w185/abc123.jpg"
  );
});

test("matched TMDB poster is preferred over verified cinema artwork", () => {
  assert.deepEqual(
    posterCandidates(
      { match_status: "matched", poster_path: "/abc123.jpg" },
      "https://cinema.example/poster.jpg"
    ),
    [
      "https://image.tmdb.org/t/p/w185/abc123.jpg",
      "https://cinema.example/poster.jpg",
    ]
  );
});

test("verified cinema artwork is used when no safe TMDB poster exists", () => {
  assert.deepEqual(
    posterCandidates(
      { match_status: "needs_review", poster_path: "/wrong.jpg" },
      "https://cinema.example/poster.jpg"
    ),
    ["https://cinema.example/poster.jpg"]
  );
});

test("verified cinema artwork is used when matched movie has no poster", () => {
  assert.deepEqual(
    posterCandidates(
      { match_status: "matched", poster_path: null },
      "https://cinema.example/poster.jpg"
    ),
    ["https://cinema.example/poster.jpg"]
  );
});

test("unsafe or malformed artwork URLs are ignored", () => {
  assert.deepEqual(posterCandidates(null, "javascript:alert(1)"), []);
  assert.deepEqual(posterCandidates(null, "not a url"), []);
});
