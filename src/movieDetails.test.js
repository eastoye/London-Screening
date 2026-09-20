import assert from "node:assert/strict";
import test from "node:test";
import {
  addSharedMovieDetails,
  formatRuntime,
  resolveMovieDetails,
} from "./movieDetails.js";

test("uses matched central movie year, genres and confirmed UK certification", () => {
  const details = resolveMovieDetails(
    {
      match_status: "matched",
      release_year: 1995,
      genres: ["Drama", "Romance"],
      uk_certification: "15",
      uk_certification_status: "confirmed",
    },
    []
  );

  assert.equal(details.releaseYear, 1995);
  assert.deepEqual(details.genres, ["Drama", "Romance"]);
  assert.equal(details.ukCertification, "15");
});

test("does not trust central metadata from an unconfirmed movie match", () => {
  const details = resolveMovieDetails(
    {
      match_status: "needs_review",
      release_year: 1970,
      genres: ["Horror"],
      uk_certification: "18",
      uk_certification_status: "confirmed",
    },
    [
      {
        id: "1",
        cinema_name: "Cinema A",
        source_release_year: 2026,
        source_runtime_minutes: 101,
        source_directors: ["Director A"],
      },
    ]
  );

  assert.equal(details.releaseYear, 2026);
  assert.deepEqual(details.genres, []);
  assert.equal(details.ukCertification, null);
});

test("runtime uses a strong cinema-level cluster and rejects split evidence", () => {
  const clustered = resolveMovieDetails(null, [
    { id: "1", cinema_name: "A", source_runtime_minutes: 99 },
    { id: "2", cinema_name: "B", source_runtime_minutes: 100 },
    { id: "3", cinema_name: "C", source_runtime_minutes: 101 },
    { id: "4", cinema_name: "D", source_runtime_minutes: 121 },
  ]);
  assert.equal(clustered.runtimeMinutes, 100);

  const split = resolveMovieDetails(null, [
    { id: "1", cinema_name: "A", source_runtime_minutes: 100 },
    { id: "2", cinema_name: "B", source_runtime_minutes: 120 },
  ]);
  assert.equal(split.runtimeMinutes, null);
});

test("director consensus is based on cinema votes rather than screening count", () => {
  const details = resolveMovieDetails(null, [
    { id: "1", cinema_name: "A", source_directors: ["Jane Doe"] },
    { id: "2", cinema_name: "A", source_directors: ["Jane Doe"] },
    { id: "3", cinema_name: "B", source_directors: ["Jane Doe"] },
    { id: "4", cinema_name: "C", source_directors: ["Other Director"] },
  ]);

  assert.deepEqual(details.directors, ["Jane Doe"]);
});

test("shared details are attached to every screening linked to the same movie", () => {
  const rows = addSharedMovieDetails([
    {
      id: "1",
      movie_id: "movie-1",
      cinema_name: "A",
      source_runtime_minutes: 90,
      movies: { match_status: "matched", release_year: 2026 },
    },
    {
      id: "2",
      movie_id: "movie-1",
      cinema_name: "B",
      source_runtime_minutes: 90,
      movies: { match_status: "matched", release_year: 2026 },
    },
  ]);

  assert.equal(rows[0].shared_movie_details.releaseYear, 2026);
  assert.equal(rows[1].shared_movie_details.runtimeMinutes, 90);
});

test("formatRuntime produces compact human-readable durations", () => {
  assert.equal(formatRuntime(102), "1h 42m");
  assert.equal(formatRuntime(120), "2h");
  assert.equal(formatRuntime(45), "45 min");
});
