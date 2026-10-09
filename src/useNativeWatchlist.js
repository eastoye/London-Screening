import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createNativeWatchlistApi } from "./nativeWatchlistApi.js";
import { normaliseTmdbId, sortWatchlistItems } from "./nativeWatchlist.js";
import { supabase } from "./supabaseClient.js";

const watchlistApi = createNativeWatchlistApi(supabase);

function updateBusySet(setter, tmdbId, busy) {
  setter((current) => {
    const next = new Set(current);
    if (busy) next.add(tmdbId);
    else next.delete(tmdbId);
    return next;
  });
}

function mergeListWithMutations(items, addedItems, removedTmdbIds) {
  const byTmdbId = new Map(
    items
      .filter((item) => !removedTmdbIds.has(item.tmdbId))
      .map((item) => [item.tmdbId, item])
  );

  for (const [tmdbId, item] of addedItems) {
    if (!removedTmdbIds.has(tmdbId)) byTmdbId.set(tmdbId, item);
  }

  return sortWatchlistItems([...byTmdbId.values()]);
}

export function useNativeWatchlist(user) {
  const userId = user?.id ?? null;
  const activeUserIdRef = useRef(userId);
  const requestVersionRef = useRef(0);
  const addedItemsSinceListRef = useRef(new Map());
  const removedTmdbIdsSinceListRef = useRef(new Set());
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [savingTmdbIds, setSavingTmdbIds] = useState(() => new Set());
  const [removingTmdbIds, setRemovingTmdbIds] = useState(() => new Set());

  useEffect(() => {
    activeUserIdRef.current = userId;
    const version = requestVersionRef.current + 1;
    requestVersionRef.current = version;
    addedItemsSinceListRef.current = new Map();
    removedTmdbIdsSinceListRef.current = new Set();
    setItems([]);
    setError("");
    setSavingTmdbIds(new Set());
    setRemovingTmdbIds(new Set());

    if (!userId) {
      setStatus("idle");
      return undefined;
    }

    let active = true;
    setStatus("loading");

    watchlistApi
      .list(userId)
      .then((nextItems) => {
        if (
          active &&
          requestVersionRef.current === version &&
          activeUserIdRef.current === userId
        ) {
          setItems(
            mergeListWithMutations(
              nextItems,
              addedItemsSinceListRef.current,
              removedTmdbIdsSinceListRef.current
            )
          );
          addedItemsSinceListRef.current = new Map();
          removedTmdbIdsSinceListRef.current = new Set();
          setStatus("ready");
        }
      })
      .catch((loadError) => {
        if (
          active &&
          requestVersionRef.current === version &&
          activeUserIdRef.current === userId
        ) {
          setError(loadError.message);
          setStatus("error");
        }
      });

    return () => {
      active = false;
    };
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return [];

    const version = requestVersionRef.current + 1;
    requestVersionRef.current = version;
    addedItemsSinceListRef.current = new Map();
    removedTmdbIdsSinceListRef.current = new Set();
    setStatus("loading");
    setError("");

    try {
      const nextItems = await watchlistApi.list(userId);
      if (
        requestVersionRef.current === version &&
        activeUserIdRef.current === userId
      ) {
        setItems(
          mergeListWithMutations(
            nextItems,
            addedItemsSinceListRef.current,
            removedTmdbIdsSinceListRef.current
          )
        );
        addedItemsSinceListRef.current = new Map();
        removedTmdbIdsSinceListRef.current = new Set();
        setStatus("ready");
      }
      return nextItems;
    } catch (refreshError) {
      if (
        requestVersionRef.current === version &&
        activeUserIdRef.current === userId
      ) {
        setError(refreshError.message);
        setStatus("error");
      }
      throw refreshError;
    }
  }, [userId]);

  const add = useCallback(
    async (tmdbId) => {
      const id = normaliseTmdbId(tmdbId);
      if (!userId || !id) {
        throw new Error("Log in and select a valid film first.");
      }

      updateBusySet(setSavingTmdbIds, id, true);
      setError("");

      try {
        const item = await watchlistApi.add(id);

        if (activeUserIdRef.current === userId) {
          addedItemsSinceListRef.current.set(item.tmdbId, item);
          removedTmdbIdsSinceListRef.current.delete(item.tmdbId);
          setItems((current) =>
            sortWatchlistItems([
              item,
              ...current.filter((saved) => saved.tmdbId !== item.tmdbId),
            ])
          );
          setStatus("ready");
        }

        return item;
      } catch (addError) {
        if (activeUserIdRef.current === userId) {
          setError(addError.message);
        }
        throw addError;
      } finally {
        if (activeUserIdRef.current === userId) {
          updateBusySet(setSavingTmdbIds, id, false);
        }
      }
    },
    [userId]
  );

  const remove = useCallback(
    async (tmdbId) => {
      const id = normaliseTmdbId(tmdbId);
      if (!userId || !id) {
        throw new Error("Log in and select a saved film first.");
      }

      updateBusySet(setRemovingTmdbIds, id, true);
      setError("");

      try {
        await watchlistApi.remove(userId, id);
        if (activeUserIdRef.current === userId) {
          addedItemsSinceListRef.current.delete(id);
          removedTmdbIdsSinceListRef.current.add(id);
          setItems((current) =>
            current.filter((item) => item.tmdbId !== id)
          );
          setStatus("ready");
        }
      } catch (removeError) {
        if (activeUserIdRef.current === userId) {
          setError(removeError.message);
        }
        throw removeError;
      } finally {
        if (activeUserIdRef.current === userId) {
          updateBusySet(setRemovingTmdbIds, id, false);
        }
      }
    },
    [userId]
  );

  const tmdbIds = useMemo(
    () => new Set(items.map((item) => item.tmdbId)),
    [items]
  );

  const clearError = useCallback(() => setError(""), []);

  return {
    add,
    clearError,
    error,
    items,
    refresh,
    remove,
    removingTmdbIds,
    savingTmdbIds,
    search: watchlistApi.search,
    status,
    tmdbIds,
  };
}
