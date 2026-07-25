import { useCallback, useEffect, useRef, useState } from "react";
import {
  TRAKT_CONFIGURED,
  TraktAuthError,
  clearTraktToken,
  exchangeTraktCode,
  fetchAllTraktRatings,
  getTraktAuthorizationUrl,
  loadTraktToken,
  saveTraktToken,
} from "./traktApi.js";

const OAUTH_STATE_KEY = "london_screenings_trakt_oauth_state";
const OAUTH_MESSAGE = "london-screenings-trakt-callback";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function createOAuthState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storeOAuthState(value) {
  localStorage.setItem(
    OAUTH_STATE_KEY,
    JSON.stringify({ value, createdAt: Date.now() })
  );
}

function consumeOAuthState(receivedState) {
  const raw = localStorage.getItem(OAUTH_STATE_KEY);
  localStorage.removeItem(OAUTH_STATE_KEY);
  if (!raw || !receivedState) return false;

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

export function useTrakt() {
  const [token, setToken] = useState(loadTraktToken);
  const [ratings, setRatings] = useState([]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const popupRef = useRef(null);
  const processedCodesRef = useRef(new Set());

  const loadRatings = useCallback(async (currentToken) => {
    setStatus("fetching");
    setError("");

    try {
      const result = await fetchAllTraktRatings(currentToken);
      saveTraktToken(result.token);
      setToken(result.token);
      setRatings(result.ratings);
      setStatus("ready");
    } catch (err) {
      if (err instanceof TraktAuthError) {
        clearTraktToken();
        setToken(null);
        setRatings([]);
        setError("Your Trakt connection expired. Please connect again.");
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Your Trakt ratings could not be loaded."
        );
      }
      setStatus("error");
    }
  }, []);

  const handleOAuthCallback = useCallback(
    async (code, receivedState) => {
      if (!code || processedCodesRef.current.has(code)) return;
      processedCodesRef.current.add(code);

      if (!consumeOAuthState(receivedState)) {
        setError("The Trakt connection could not be verified. Please try again.");
        setStatus("error");
        return;
      }

      setStatus("exchanging");
      setError("");
      try {
        const newToken = await exchangeTraktCode(code);
        saveTraktToken(newToken);
        setToken(newToken);
        await loadRatings(newToken);
      } catch (err) {
        clearTraktToken();
        setToken(null);
        setRatings([]);
        setError(
          err instanceof Error ? err.message : "Trakt could not be connected."
        );
        setStatus("error");
      }
    },
    [loadRatings]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const receivedState = params.get("state");
    const oauthError = params.get("error");
    if (!code && !oauthError) return;

    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${window.location.hash}`
    );

    if (window.opener && window.opener !== window) {
      window.opener.postMessage(
        { type: OAUTH_MESSAGE, code, state: receivedState, error: oauthError },
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
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== OAUTH_MESSAGE) return;

      popupRef.current?.close();
      popupRef.current = null;

      if (event.data.error) {
        localStorage.removeItem(OAUTH_STATE_KEY);
        setError("Trakt connection was cancelled.");
        setStatus("error");
        return;
      }

      handleOAuthCallback(event.data.code, event.data.state);
    };

    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [handleOAuthCallback]);

  useEffect(() => {
    if (token && status === "idle") loadRatings(token);
  }, [loadRatings, status, token]);

  const connect = useCallback(() => {
    if (!TRAKT_CONFIGURED) {
      setError("Trakt is not configured for this site yet.");
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
      Math.round(window.screenX + (window.outerWidth - width) / 2)
    );
    const top = Math.max(
      0,
      Math.round(window.screenY + (window.outerHeight - height) / 2)
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
    clearTraktToken();
    setToken(null);
    setRatings([]);
    setError("");
    setStatus("idle");
  }, []);

  const refresh = useCallback(() => {
    if (token) loadRatings(token);
  }, [loadRatings, token]);

  return {
    status,
    error,
    ratings,
    isConnected: Boolean(token),
    isConfigured: TRAKT_CONFIGURED,
    connect,
    disconnect,
    refresh,
  };
}