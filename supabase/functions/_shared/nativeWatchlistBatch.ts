export const NATIVE_IMPORT_BATCH_SIZE = 20;
export const TMDB_LOOKUP_CONCURRENCY = 4;

export async function readWatchlistBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("JSON is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) {
      await reader.cancel();
      throw new RangeError("The request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

type Movie = { tmdbId: number; title: string; releaseYear: number | null; posterPath: string | null };
type Row = { user_id: string; tmdb_id: number; display_title: string; release_year: number | null; poster_path: string | null; metadata_updated_at: string };
type Outcome = { tmdbId: number; status: "added" | "already_saved" | "failed"; error?: string };
type Dependencies = {
  existing: (userId: string, ids: number[]) => Promise<number[]>;
  movie: (id: number) => Promise<Movie>;
  insert: (rows: Row[]) => Promise<number[]>;
};

export function validateImportIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > NATIVE_IMPORT_BATCH_SIZE) {
    throw new Error(`Import between 1 and ${NATIVE_IMPORT_BATCH_SIZE} film IDs per batch.`);
  }
  if (value.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Every film must have a positive integer TMDB ID.");
  }
  return [...new Set(value as number[])];
}

// userId must come exclusively from auth.getUser(), never the request body.
// The existing primary key and INSERT ON CONFLICT DO NOTHING arbitrate concurrent imports.
export async function importWatchlistBatch(userId: string, ids: number[], deps: Dependencies) {
  if (!userId) throw new Error("Authentication is required.");
  ids = validateImportIds(ids);
  const results = new Map<number, Outcome>();
  const existing = new Set(await deps.existing(userId, ids));
  const pending = ids.filter((id) => !existing.has(id));
  for (const id of existing) results.set(id, { tmdbId: id, status: "already_saved" });
  const rows: Row[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(TMDB_LOOKUP_CONCURRENCY, pending.length) }, async () => {
    while (next < pending.length) {
      const id = pending[next++];
      try {
        const movie = await deps.movie(id);
        if (movie.tmdbId !== id || !movie.title.trim()) throw new Error("Film metadata could not be verified.");
        rows.push({
          user_id: userId, tmdb_id: id, display_title: movie.title,
          release_year: movie.releaseYear, poster_path: movie.posterPath,
          metadata_updated_at: new Date().toISOString(),
        });
      } catch (error) {
        results.set(id, { tmdbId: id, status: "failed", error: error instanceof Error ? error.message : "Film verification failed." });
      }
    }
  }));
  if (rows.length) {
    try {
      const inserted = new Set(await deps.insert(rows));
      for (const row of rows) results.set(row.tmdb_id, {
        tmdbId: row.tmdb_id, status: inserted.has(row.tmdb_id) ? "added" : "already_saved",
      });
    } catch {
      for (const row of rows) results.set(row.tmdb_id, {
        tmdbId: row.tmdb_id, status: "failed",
        error: "Saving could not be confirmed. Retry safely; existing films will be kept.",
      });
    }
  }
  return { userId, results: ids.map((id) => results.get(id)!) };
}
