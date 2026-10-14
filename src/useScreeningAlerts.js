import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { supabase } from "./supabaseClient.js";
import { createScreeningAlertsApi, createScreeningAlertsStore, emptyAlertsState } from "./screeningAlerts.js";

const api = createScreeningAlertsApi(supabase);

export function useScreeningAlerts(user) {
  const store = useMemo(() => createScreeningAlertsStore(api), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const userId = user?.id ?? null;
  const email = user?.email ?? "";

  useEffect(() => {
    store.setAccount(userId, email);
    if (userId) void store.refresh();
    return () => store.setAccount(null);
  }, [store, userId, email]);

  const current = snapshot.userId === userId && snapshot.accountEmail === email ? snapshot : emptyAlertsState(userId, email);
  const tmdbIds = useMemo(() => new Set(current.films.map(film => film.tmdbId)), [current.films]);
  const refresh = useCallback(() => store.refresh(), [store]);

  return { ...current, tmdbIds, refresh, clearError: store.clearError, search: store.search, follow: store.follow, remove: store.remove, setPaused: store.setPaused, requestVerification: store.requestVerification, disableEmail: store.disableEmail };
}
