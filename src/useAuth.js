import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAuthApi,
  observeAuthSession,
  parseAuthRedirectHash,
} from "./authApi.js";
import {
  INITIAL_AUTH_REDIRECT_HASH,
  supabase,
} from "./supabaseClient.js";

const authApi = createAuthApi(supabase);

function confirmationRedirectUrl() {
  return new URL("/", window.location.origin).toString();
}

function removeAuthRedirectHash() {
  window.history.replaceState(
    {},
    document.title,
    `${window.location.pathname}${window.location.search}`
  );
}

export function useAuth() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [initializationError, setInitializationError] = useState("");
  const [notice, setNotice] = useState(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const redirectRef = useRef(undefined);

  if (redirectRef.current === undefined) {
    redirectRef.current =
      parseAuthRedirectHash(INITIAL_AUTH_REDIRECT_HASH) || null;
  }

  useEffect(() => {
    let active = true;
    let latestSession = null;
    const redirect = redirectRef.current || null;

    if (redirect?.kind === "error") {
      setNotice({
        type: "error",
        message: redirect.message,
      });
    }

    if (redirect?.kind === "recovery") {
      setRecoveryMode(true);
    }

    const observer = observeAuthSession(authApi, (nextState) => {
      latestSession = nextState.session;
      setSession(nextState.session);
      setLoading(nextState.loading);
      setInitializationError(nextState.error?.message || "");

      if (redirect?.kind === "confirmation" && nextState.session?.user) {
        setNotice({
          type: "success",
          message: redirect.message,
        });
      }
    });

    observer.ready.finally(() => {
      if (!active || !redirect) return;

      if (redirect.kind === "confirmation" && !latestSession?.user) {
        setNotice({
          type: "error",
          message:
            "We couldn't complete email confirmation. Try logging in, or request a new confirmation email.",
        });
      }

      if (redirect.kind === "recovery" && !latestSession?.user) {
        setNotice({
          type: "error",
          message:
            "This password reset link has expired or has already been used. Request a new reset link from the log in page.",
        });
        setRecoveryMode(false);
      }

      removeAuthRedirectHash();
    });

    return () => {
      active = false;
      observer.stop();
    };
  }, []);

  const signIn = useCallback(
    async (email, password) => {
      if (session?.user) {
        return {
          alreadyAuthenticated: true,
          session,
          user: session.user,
        };
      }

      const result = await authApi.signIn(email, password);

      setInitializationError("");
      setSession(result.session);

      return result;
    },
    [session]
  );

  const signUp = useCallback(
    async (email, password) => {
      if (session?.user) {
        return {
          alreadyAuthenticated: true,
          confirmationRequired: false,
          session,
          user: session.user,
        };
      }

      const result = await authApi.signUp(
        email,
        password,
        confirmationRedirectUrl()
      );

      setInitializationError("");

      if (result.session) {
        setSession(result.session);
      }

      return result;
    },
    [session]
  );

  const signOut = useCallback(async () => {
    await authApi.signOut();
    setSession(null);
  }, []);

  const resetPassword = useCallback(async (email) => {
    await authApi.resetPassword(email, confirmationRedirectUrl());
  }, []);

  const updateUserPassword = useCallback(async (newPassword) => {
    await authApi.updateUserPassword(newPassword);
    setRecoveryMode(false);
    setNotice({
      type: "success",
      message: "Your password has been updated.",
    });
  }, []);

  const clearRecoveryMode = useCallback(() => {
    setRecoveryMode(false);
  }, []);

  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);

  return {
    clearNotice,
    clearRecoveryMode,
    initializationError,
    isAuthenticated: Boolean(session?.user),
    loading,
    notice,
    recoveryMode,
    session,
    signIn,
    signOut,
    signUp,
    resetPassword,
    updateUserPassword,
    user: session?.user ?? null,
  };
}
