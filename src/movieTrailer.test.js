import assert from "node:assert/strict";
import test from "node:test";
import { selectMovieTrailer } from "../supabase/functions/enrich-movie-metadata/trailerSelection.js";
import { getMovieTrailerUrl } from "./movieTrailer.js";

const video = (key, changes = {}) => ({
  key, site: "YouTube", type: "Trailer", official: true,
  name: "Official Trailer", iso_639_1: "en", iso_3166_1: "GB",
  size: 1080, published_at: "2025-02-01T00:00:00Z", ...changes,
});

test("official trailer wins over unofficial, with English and GB as later preferences", () => {
  const videos = [
    video("unofficial1", { official: false, size: 2160 }),
    video("officialFR1", { iso_639_1: "fr", size: 2160 }),
    video("officialUS1", { iso_3166_1: "US", size: 2160 }),
    video("officialGB1", { size: 720 }),
  ];
  assert.equal(selectMovieTrailer(videos), "officialGB1");
  assert.equal(selectMovieTrailer([...videos].reverse()), "officialGB1");
});

test("only YouTube Trailer entries qualify; teasers and featurettes are excluded", () => {
  const videos = [
    video("vimeoKey001", { site: "Vimeo" }),
    video("teaserKey01", { type: "Teaser" }),
    video("featureKey1", { type: "Featurette" }),
    video("interview01", { type: "Interview" }),
  ];
  assert.equal(selectMovieTrailer(videos), null);
  assert.equal(selectMovieTrailer([...videos, video("realTrailer")]), "realTrailer");
});

test("unofficial entries need a clear trailer name and reject fan edits", () => {
  assert.equal(selectMovieTrailer([video("noTitle0001", { official: false, name: "Clip" })]), null);
  assert.equal(selectMovieTrailer([video("fanMade0001", { official: false, name: "Fan-made Trailer" })]), null);
  assert.equal(selectMovieTrailer([video("realTrailer", { official: false, name: "Main Trailer" })]), "realTrailer");
});

test("missing or malformed video data never produces a link", () => {
  assert.equal(selectMovieTrailer(null), null);
  assert.equal(selectMovieTrailer([]), null);
  assert.equal(selectMovieTrailer([null, {}, video("invalid"), video("unsafeKey11", { official: "true" })]), null);
  assert.equal(selectMovieTrailer([video("validKey001", { key: "bad&key=xxx" })]), null);
});

test("duplicate keys resolve predictably; candidates with equal rank use stable key", () => {
  const duplicate = video("duplicate01", { official: false });
  assert.equal(selectMovieTrailer([duplicate, video("duplicate01"), video("otherKey01", { official: false })]), "duplicate01");
  assert.equal(selectMovieTrailer([video("bbbbbbbbbbb"), video("aaaaaaaaaaa")]), "aaaaaaaaaaa");
});

test("a trailer is exposed only for a matched movie with the exact cached TMDB identity", () => {
  const movie = {
    match_status: "matched", tmdb_id: 348, trailer_tmdb_id: 348,
    trailer_youtube_key: "abcdefghijk", trailer_checked_at: "2026-09-20T12:00:00Z",
  };
  assert.equal(getMovieTrailerUrl(movie), "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal(getMovieTrailerUrl({ ...movie, match_status: "needs_review" }), null);
  assert.equal(getMovieTrailerUrl({ ...movie, match_status: "unmatched" }), null);
  assert.equal(getMovieTrailerUrl({ ...movie, tmdb_id: 349 }), null);
  assert.equal(getMovieTrailerUrl({ ...movie, trailer_tmdb_id: null }), null);
  assert.equal(getMovieTrailerUrl({ ...movie, trailer_youtube_key: null }), null);
  assert.equal(getMovieTrailerUrl({ ...movie, trailer_youtube_key: "abcdefghijk&x=1" }), null);
  assert.equal(getMovieTrailerUrl({ ...movie, trailer_checked_at: null }), null);
});
