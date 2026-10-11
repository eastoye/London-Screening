import { deduplicateConfirmed } from "./model.js";

export const NATIVE_DESTINATION = "native";
export const TRAKT_DESTINATION = "trakt";

export function recordSelection(record, destination) {
  if (destination === NATIVE_DESTINATION && !record.watchlist && !record.nativeIncluded) return null;
  return destination === NATIVE_DESTINATION
    ? record.nativeSelectedTmdbId ?? null
    : record.selectedTmdbId ?? null;
}

export function confirmedForDestination(records, destination) {
  const selected = records.flatMap((record) => {
    const selectedTmdbId = recordSelection(record, destination);
    if (!selectedTmdbId || !["matched", "ambiguous"].includes(record.status)) return [];
    const candidates = [record.match, ...(record.candidates || [])].filter(Boolean);
    if (!candidates.some((candidate) => candidate.tmdbId === selectedTmdbId)) return [];
    return [{ ...record, selectedTmdbId }];
  });
  return deduplicateConfirmed(selected).filter((record) =>
    destination === NATIVE_DESTINATION || !record.ratingConflict && !record.ratingInvalidReason
  );
}

export function initialiseDestinationSelections(records) {
  return records.map((record) => ({
    ...record,
    nativeIncluded: Boolean(record.watchlist),
    nativeSelectedTmdbId: record.watchlist ? record.selectedTmdbId : null,
  }));
}
