import assert from "node:assert/strict";
import test from "node:test";
import { addSharedMovieArtwork } from "./movieArtwork.js";

test("shares verified artwork across screenings linked to the same movie", () => {
  const rows = addSharedMovieArtwork([
    {
      id: "a",
      movie_id: "movie-1",
      movie_title: "Resident Evil",
      verified_artwork_url: null,
    },
    {
      id: "b",
      movie_id: "movie-1",
      movie_title: "Resident Evil",
      verified_artwork_url: "https://cinema.example/resident-evil.jpg",
    },
  ]);

  assert.deepEqual(rows[0].peer_verified_artwork_urls, [
    "https://cinema.example/resident-evil.jpg",
  ]);
});

test("does not share artwork between different movie records", () => {
  const rows = addSharedMovieArtwork([
    {
      id: "a",
      movie_id: "movie-1",
      movie_title: "Pressure",
      verified_artwork_url: null,
    },
    {
      id: "b",
      movie_id: "movie-2",
      movie_title: "Pressure",
      verified_artwork_url: "https://cinema.example/wrong.jpg",
    },
  ]);

  assert.deepEqual(rows[0].peer_verified_artwork_urls, []);
});

test("prefers artwork from the same public-title variant", () => {
  const rows = addSharedMovieArtwork([
    {
      id: "a",
      movie_id: "movie-1",
      movie_title: "Queen at Sea",
      verified_artwork_url: null,
    },
    {
      id: "b",
      movie_id: "movie-1",
      movie_title: "Queen at Sea + Q&A",
      verified_artwork_url: "https://cinema.example/qa.jpg",
    },
    {
      id: "c",
      movie_id: "movie-1",
      movie_title: "Queen At Sea",
      verified_artwork_url: "https://cinema.example/regular.jpg",
    },
  ]);

  assert.deepEqual(rows[0].peer_verified_artwork_urls, [
    "https://cinema.example/regular.jpg",
    "https://cinema.example/qa.jpg",
  ]);
});
