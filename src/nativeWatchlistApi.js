import { normaliseTmdbId, sortWatchlistItems } from "./nativeWatchlist.js";

const WATCHLIST_COLUMNS =
  "tmdb_id, display_title, release_year, poster_path, added_at, metadata_updated_at";

export class NativeWatchlistError extends Error {
  constructor(message, code = "native_watchlist_error") {
    super(message);
    this.name = "NativeWatchlistError";
    this.code = code;
  }
}

function mapWatchlistRow(row) {
  const tmdbId = normaliseTmdbId(row?.tmdb_id);
  const displayTitle = String(row?.display_title ?? "").trim();

  if (!tmdbId || !displayTitle) return null;

  const releaseYear =
    row.release_year === null || row.release_year === undefined
      ? null
      : Number(row.release_year);

  return {
    tmdbId,
    displayTitle,
    releaseYear: Number.isInteger(releaseYear) && releaseYear > 0 ? releaseYear : null,
    posterPath:
      typeof row.poster_path === "string" && row.poster_path.startsWith("/")
        ? row.poster_path
        : null,
    addedAt: String(row.added_at ?? ""),
    metadataUpdatedAt: String(row.metadata_updated_at ?? ""),
  };
}

function mapCandidate(value) {
  const tmdbId = normaliseTmdbId(value?.tmdbId);
  const title = String(value?.title ?? "").trim();
  if (!tmdbId || !title) return null;

  const releaseYear =
    value.releaseYear === null || value.releaseYear === undefined
      ? null
      : Number(value.releaseYear);

  return {
    tmdbId,
    title,
    originalTitle:
      typeof value.originalTitle === "string" && value.originalTitle.trim()
        ? value.originalTitle.trim()
        : null,
    releaseYear: Number.isInteger(releaseYear) && releaseYear > 0 ? releaseYear : null,
    posterPath:
      typeof value.posterPath === "string" && value.posterPath.startsWith("/")
        ? value.posterPath
        : null,
    overview:
      typeof value.overview === "string" ? value.overview.trim() : "",
  };
}

async function functionErrorMessage(error, fallback) {
  const response = error?.context;

  if (response && typeof response.json === "function") {
    try {
      const body = await response.json();
      if (typeof body?.error === "string" && body.error.trim()) {
        return body.error.trim();
      }
    } catch {
      // Fall back to the stable user-facing message below.
    }
  }

  return fallback;
}

export function createNativeWatchlistApi(client) {
  if (!client?.from || !client?.functions?.invoke) {
    throw new TypeError("A configured Supabase client is required.");
  }

  return {
    async list(userId) {
      if (!userId) return [];

      const { data, error } = await client
        .from("user_watchlist")
        .select(WATCHLIST_COLUMNS)
        .eq("user_id", userId)
        .order("added_at", { ascending: false });

      if (error) {
        throw new NativeWatchlistError(
          "Your watchlist could not be loaded. Please try again.",
          error.code
        );
      }

      return sortWatchlistItems(
        (data ?? []).map(mapWatchlistRow).filter(Boolean)
      );
    },

    async search(query) {
      const cleanQuery = String(query ?? "").trim().slice(0, 200);

      if (cleanQuery.length < 2) {
        throw new NativeWatchlistError(
          "Enter at least two characters to search.",
          "invalid_query"
        );
      }

      const { data, error } = await client.functions.invoke(
        "native-watchlist-movies",
        { body: { action: "search", query: cleanQuery } }
      );

      if (error) {
        throw new NativeWatchlistError(
          await functionErrorMessage(
            error,
            "Films could not be searched right now. Please try again."
          ),
          "search_failed"
        );
      }

      return Array.isArray(data?.candidates)
        ? data.candidates.map(mapCandidate).filter(Boolean)
        : [];
    },

    async add(tmdbId) {
      const id = normaliseTmdbId(tmdbId);

      if (!id) {
        throw new NativeWatchlistError(
          "A valid film must be selected.",
          "invalid_tmdb_id"
        );
      }

      const { data, error } = await client.functions.invoke(
        "native-watchlist-movies",
        { body: { action: "add", tmdbId: id } }
      );

      if (error) {
        throw new NativeWatchlistError(
          await functionErrorMessage(
            error,
            "The film could not be saved. Please try again."
          ),
          "add_failed"
        );
      }

      const item = mapWatchlistRow({
        tmdb_id: data?.item?.tmdbId,
        display_title: data?.item?.displayTitle,
        release_year: data?.item?.releaseYear,
        poster_path: data?.item?.posterPath,
        added_at: data?.item?.addedAt,
        metadata_updated_at: data?.item?.metadataUpdatedAt,
      });

      if (!item) {
        throw new NativeWatchlistError(
          "The watchlist service returned an invalid film.",
          "invalid_response"
        );
      }

      return item;
    },

    async remove(userId, tmdbId) {
      const id = normaliseTmdbId(tmdbId);

      if (!userId || !id) {
        throw new NativeWatchlistError(
          "A valid saved film is required.",
          "invalid_remove"
        );
      }

      const { error } = await client
        .from("user_watchlist")
        .delete()
        .eq("user_id", userId)
        .eq("tmdb_id", id);

      if (error) {
        throw new NativeWatchlistError(
          "The film could not be removed. Please try again.",
          error.code
        );
      }
    },
  };
}
