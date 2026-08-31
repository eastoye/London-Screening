import { useCallback, useEffect, useRef, useState } from "react";
import {
  TRAKT_CONFIGURED,
  TraktAuthError,
  clearTraktToken,
  exchangeTraktCode,
  fetchAllTraktRatings,
  fetchAllTraktWatchlist,
  getTraktAuthorizationUrl,
  loadTraktToken,
  saveTraktToken,
  syncTraktImport,
} from "./traktApi.js";

const OAUTH_STATE_KEY = "london_screenings_trakt_oauth_state";
const OAUTH_MESSAGE = "london-screenings-trakt-callback";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function createOAuthState() {
  const bytes = new Uint8Array(24);

  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function storeOAuthState(value) {
  localStorage.setItem(
    OAUTH_STATE_KEY,
    JSON.stringify({
      value,
      createdAt: Date.now(),
    })
  );
}

function consumeOAuthState(receivedState) {
  const raw = localStorage.getItem(OAUTH_STATE_KEY);

  localStorage.removeItem(OAUTH_STATE_KEY);

  if (!raw || !receivedState) {
    return false;
  }

  try {
    const stored = JSON.parse(raw);

    return (
      typeof stored.value === "string" &&
      stored.value === receivedState &&
      Number.isFinite(stored.createdAt) &&
      Date.now() - stored.createdAt <= STATE_MAX_AGE_MS
    );
  } catch {
    return false;
  }
}

function errorMessage(error, fallback) {
  return error instanceof Error
    ? error.message
    : fallback;
}

export function useTrakt() {
  const [token, setToken] = useState(loadTraktToken);
  const [ratings, setRatings] = useState([]);
  const [watchlistTmdbIds, setWatchlistTmdbIds] = useState([]);

  const [status, setStatus] = useState("idle");
  const [ratingsStatus, setRatingsStatus] = useState("idle");
  const [watchlistStatus, setWatchlistStatus] =
    useState("idle");

  const [error, setError] = useState("");
  const [ratingsError, setRatingsError] = useState("");
  const [watchlistError, setWatchlistError] =
    useState("");

  const popupRef = useRef(null);
  const processedCodesRef = useRef(new Set());
  const loadRequestRef = useRef(0);

  const clearConnection = useCallback(
    (message = "", nextStatus = "idle") => {
      loadRequestRef.current += 1;

      clearTraktToken();
      setToken(null);
      setRatings([]);
      setWatchlistTmdbIds([]);

      setRatingsStatus("idle");
      setWatchlistStatus("idle");

      setRatingsError("");
      setWatchlistError("");
      setError(message);
      setStatus(nextStatus);
    },
    []
  );

  const loadTraktData = useCallback(
    async (currentToken) => {
      const requestId = loadRequestRef.current + 1;

      loadRequestRef.current = requestId;

      setStatus("fetching");
      setRatingsStatus("loading");
      setWatchlistStatus("loading");

      setError("");
      setRatingsError("");
      setWatchlistError("");

      let latestToken = currentToken;
      const sourceErrors = [];

      try {
        const ratingsResult =
          await fetchAllTraktRatings(latestToken);

        if (requestId !== loadRequestRef.current) {
          return;
        }

        latestToken = ratingsResult.token;

        saveTraktToken(latestToken);
        setToken(latestToken);
        setRatings(ratingsResult.ratings);
        setRatingsStatus("ready");
      } catch (loadError) {
        if (requestId !== loadRequestRef.current) {
          return;
        }

        if (loadError instanceof TraktAuthError) {
          clearConnection(
            "Your Trakt connection expired. Please connect again.",
            "error"
          );
          return;
        }

        const message = errorMessage(
          loadError,
          "Your Trakt ratings could not be loaded."
        );

        sourceErrors.push(message);
        setRatingsError(message);
        setRatingsStatus("error");
      }

      try {
        const watchlistResult =
          await fetchAllTraktWatchlist(latestToken);

        if (requestId !== loadRequestRef.current) {
          return;
        }

        latestToken = watchlistResult.token;

        saveTraktToken(latestToken);
        setToken(latestToken);
        setWatchlistTmdbIds(
          watchlistResult.watchlistTmdbIds
        );
        setWatchlistStatus("ready");
      } catch (loadError) {
        if (requestId !== loadRequestRef.current) {
          return;
        }

        if (loadError instanceof TraktAuthError) {
          clearConnection(
            "Your Trakt connection expired. Please connect again.",
            "error"
          );
          return;
        }

        const message = errorMessage(
          loadError,
          "Your Trakt watchlist could not be loaded."
        );

        sourceErrors.push(message);
        setWatchlistError(message);
        setWatchlistStatus("error");
      }

      if (requestId !== loadRequestRef.current) {
        return;
      }

      setError(sourceErrors.join(" "));
      setStatus("ready");
    },
    [clearConnection]
  );

  const handleOAuthCallback = useCallback(
    async (code, receivedState) => {
      if (
        !code ||
        processedCodesRef.current.has(code)
      ) {
        return;
      }

      processedCodesRef.current.add(code);

      if (!consumeOAuthState(receivedState)) {
        setError(
          "The Trakt connection could not be verified. Please try again."
        );
        setStatus("error");
        return;
      }

      loadRequestRef.current += 1;

      setStatus("exchanging");
      setError("");
      setRatingsError("");
      setWatchlistError("");

      try {
        const newToken = await exchangeTraktCode(code);

        saveTraktToken(newToken);
        setToken(newToken);

        await loadTraktData(newToken);
      } catch (exchangeError) {
        clearConnection(
          errorMessage(
            exchangeError,
            "Trakt could not be connected."
          ),
          "error"
        );
      }
    },
    [clearConnection, loadTraktData]
  );

  useEffect(() => {
    const params = new URLSearchParams(
      window.location.search
    );

    const code = params.get("code");
    const receivedState = params.get("state");
    const oauthError = params.get("error");

    if (!code && !oauthError) {
      return;
    }

    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${window.location.hash}`
    );

    if (
      window.opener &&
      window.opener !== window
    ) {
      window.opener.postMessage(
        {
          type: OAUTH_MESSAGE,
          code,
          state: receivedState,
          error: oauthError,
        },
        window.location.origin
      );

      window.close();
      return;
    }

    if (oauthError) {
      localStorage.removeItem(OAUTH_STATE_KEY);
      setError("Trakt connection was cancelled.");
      setStatus("error");
      return;
    }

    handleOAuthCallback(code, receivedState);
  }, [handleOAuthCallback]);

  useEffect(() => {
    const receiveMessage = (event) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      if (event.data?.type !== OAUTH_MESSAGE) {
        return;
      }

      popupRef.current?.close();
      popupRef.current = null;

      if (event.data.error) {
        localStorage.removeItem(OAUTH_STATE_KEY);
        setError("Trakt connection was cancelled.");
        setStatus("error");
        return;
      }

      handleOAuthCallback(
        event.data.code,
        event.data.state
      );
    };

    window.addEventListener(
      "message",
      receiveMessage
    );

    return () =>
      window.removeEventListener(
        "message",
        receiveMessage
      );
  }, [handleOAuthCallback]);

  useEffect(() => {
    if (token && status === "idle") {
      loadTraktData(token);
    }
  }, [loadTraktData, status, token]);

  const connect = useCallback(() => {
    if (!TRAKT_CONFIGURED) {
      setError(
        "Trakt is not configured for this site yet."
      );
      setStatus("error");
      return;
    }

    const state = createOAuthState();

    storeOAuthState(state);

    const url = getTraktAuthorizationUrl(state);
    const width = 520;
    const height = 680;

    const left = Math.max(
      0,
      Math.round(
        window.screenX +
          (window.outerWidth - width) / 2
      )
    );

    const top = Math.max(
      0,
      Math.round(
        window.screenY +
          (window.outerHeight - height) / 2
      )
    );

    const popup = window.open(
      url,
      "trakt_oauth",
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
    );

    if (!popup) {
      window.location.assign(url);
      return;
    }

    popupRef.current = popup;
  }, []);

  const disconnect = useCallback(() => {
    popupRef.current?.close();
    popupRef.current = null;

    localStorage.removeItem(OAUTH_STATE_KEY);

    clearConnection();
  }, [clearConnection]);

  const refresh = useCallback(() => {
    if (token) {
      loadTraktData(token);
    }
  }, [loadTraktData, token]);

  const importMovies = useCallback(
    async (records) => {
      if (!token) {
        throw new TraktAuthError("Connect Trakt before importing movies.");
      }

      try {
        const result = await syncTraktImport(token, records, {
          ratings,
          watchlistTmdbIds,
        });

        saveTraktToken(result.token);
        setToken(result.token);
        await loadTraktData(result.token);

        return result;
      } catch (importError) {
        if (importError instanceof TraktAuthError) {
          clearConnection(
            "Your Trakt connection expired. Please connect again.",
            "error"
          );
        }
        throw importError;
      }
    },
    [clearConnection, loadTraktData, ratings, token, watchlistTmdbIds]
  );

  return {
    status,
    error,

    ratings,
    ratingsStatus,
    ratingsError,

    watchlistTmdbIds,
    watchlistStatus,
    watchlistError,

    isConnected: Boolean(token),
    isConfigured: TRAKT_CONFIGURED,

    connect,
    disconnect,
    refresh,
    importMovies,
  };
}
