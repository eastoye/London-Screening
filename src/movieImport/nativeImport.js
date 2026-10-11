export const NATIVE_BATCH_SIZE = 20;

export async function importNativeMovies(records, { importBatch, userId, isCurrentAccount, onProgress }) {
  if (!userId || !isCurrentAccount()) throw new Error("Log in to import your watchlist.");
  const byId = new Map();
  for (const record of records) {
    const id = record.selectedTmdbId;
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Choose a verified TMDB film for every selection.");
    byId.set(id, record);
  }
  const ids = [...byId.keys()];
  if (!ids.length || ids.length > 5000) throw new Error("Select between 1 and 5,000 films.");
  const watchlist = { requested: ids.length, added: 0, existing: 0, failed: 0, failures: [] };
  let completed = 0;
  let interrupted = false;
  const fail = (id, error) => {
    watchlist.failed += 1;
    watchlist.failures.push({ tmdbId: id, title: byId.get(id).title || `TMDB ${id}`, error });
  };
  onProgress?.({ completed, total: ids.length });
  for (let index = 0; index < ids.length; index += NATIVE_BATCH_SIZE) {
    if (!isCurrentAccount()) throw new Error("The account changed. The import has stopped.");
    const batch = ids.slice(index, index + NATIVE_BATCH_SIZE);
    try {
      const data = await importBatch(userId, batch);
      if (!isCurrentAccount()) throw Object.assign(new Error("The account changed. The import has stopped."), { code: "account_changed" });
      const outcomes = new Map((data?.results || []).map((item) => [item.tmdbId, item]));
      for (const id of batch) {
        const item = outcomes.get(id);
        if (item?.status === "added") watchlist.added += 1;
        else if (item?.status === "already_saved") watchlist.existing += 1;
        else fail(id, item?.error || "Saving could not be confirmed. You can retry safely.");
      }
    } catch (error) {
      if (error.code === "account_changed" || !isCurrentAccount()) throw error;
      for (const id of batch) fail(id, error.message || "This batch could not be saved.");
      if (error.code === "authentication_required") {
        interrupted = true;
        for (const id of ids.slice(index + batch.length)) fail(id, "Not attempted because your login expired.");
        completed = ids.length;
        onProgress?.({ completed, total: ids.length });
        break;
      }
    }
    completed += batch.length;
    onProgress?.({ completed, total: ids.length });
  }
  return { destination: "native", watchlist, interrupted };
}
