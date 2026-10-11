const KEY = "london_screenings_movie_import_draft_v1";
const MAX_AGE = 30 * 60 * 1000;

export function saveImportDraft(draft, storage = globalThis.sessionStorage) {
  try {
    storage.setItem(KEY, JSON.stringify({ ...draft, version: 1, savedAt: Date.now() }));
    return true;
  } catch { return false; }
}

export function clearImportDraft(storage = globalThis.sessionStorage) {
  try { storage?.removeItem(KEY); } catch { /* In-memory handoff still works. */ }
}

export function loadImportDraft({ nativeUserId, traktAccountKey } = {}, storage = globalThis.sessionStorage) {
  try {
    const value = JSON.parse(storage?.getItem(KEY) || "null");
    if (!value) return null;
    if (value.version !== 1 || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > MAX_AGE ||
      !["native", "trakt"].includes(value.destination) || !Array.isArray(value.records) || value.records.length > 5000 ||
      (value.nativeOwnerId && value.nativeOwnerId !== nativeUserId) ||
      (value.traktOwnerId && value.traktOwnerId !== traktAccountKey)) {
      clearImportDraft(storage);
      return null;
    }
    return value;
  } catch { clearImportDraft(storage); return null; }
}
