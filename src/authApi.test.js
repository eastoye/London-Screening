import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthUiError,
  createAuthApi,
  getAuthErrorMessage,
  observeAuthSession,
  parseAuthRedirectHash,
  validateAuthForm,
  validateResetEmailForm,
  validateUpdatePasswordForm,
} from "./authApi.js";

function createClient(authMethods = {}) {
  return {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe() {} } },
      }),
      signInWithPassword: async () => ({ data: null, error: null }),
      signOut: async () => ({ error: null }),
      signUp: async () => ({ data: null, error: null }),
      resetPasswordForEmail: async () => ({ error: null }),
      updateUser: async () => ({ data: null, error: null }),
      ...authMethods,
    },
  };
}

test("restores an existing Supabase session", async () => {
  const session = { user: { id: "user-1", email: "person@example.com" } };
  const api = createAuthApi(
    createClient({
      getSession: async () => ({ data: { session }, error: null }),
    })
  );

  assert.equal(await api.restoreSession(), session);
});

test("auth events update observed state and stale restoration cannot overwrite them", async () => {
  let emitAuthEvent;
  let resolveRestoration;
  let unsubscribed = false;
  const states = [];
  const restored = new Promise((resolve) => {
    resolveRestoration = resolve;
  });

  const api = {
    onAuthStateChange(callback) {
      emitAuthEvent = callback;
      return () => {
        unsubscribed = true;
      };
    },
    restoreSession() {
      return restored;
    },
  };

  const observer = observeAuthSession(api, (state) => states.push(state));
  const signedInSession = {
    user: { id: "user-2", email: "signed-in@example.com" },
  };

  emitAuthEvent({ event: "SIGNED_IN", session: signedInSession });
  resolveRestoration(null);
  await observer.ready;

  assert.equal(states.length, 1);
  assert.equal(states[0].event, "SIGNED_IN");
  assert.equal(states[0].session, signedInSession);

  const refreshedSession = {
    user: signedInSession.user,
    access_token: "refreshed-access-token",
  };
  emitAuthEvent({ event: "TOKEN_REFRESHED", session: refreshedSession });
  assert.equal(states.at(-1).event, "TOKEN_REFRESHED");
  assert.equal(states.at(-1).session, refreshedSession);

  emitAuthEvent({ event: "SIGNED_OUT", session: null });
  assert.equal(states.at(-1).session, null);

  observer.stop();
  assert.equal(unsubscribed, true);
});

test("a restoration failure becomes a safe logged-out state", async () => {
  const states = [];
  const api = {
    onAuthStateChange() {
      return () => {};
    },
    async restoreSession() {
      throw new Error("internal connection details");
    },
  };

  const observer = observeAuthSession(api, (state) => states.push(state));
  await observer.ready;

  assert.equal(states.length, 1);
  assert.equal(states[0].event, "RESTORE_FAILED");
  assert.equal(states[0].session, null);
  assert.equal(states[0].error instanceof AuthUiError, true);
  assert.equal(
    states[0].error.message,
    "We couldn't restore your account session. You can still browse screenings."
  );
});

test("login normalises the email and returns the authenticated session", async () => {
  const session = { user: { id: "user-3", email: "person@example.com" } };
  let credentials;
  const api = createAuthApi(
    createClient({
      signInWithPassword: async (value) => {
        credentials = value;
        return { data: { session }, error: null };
      },
    })
  );

  const result = await api.signIn("  Person@Example.com ", "password123");

  assert.deepEqual(credentials, {
    email: "person@example.com",
    password: "password123",
  });
  assert.equal(result.session, session);
  assert.equal(result.user, session.user);
});

test("signup reports when email confirmation is required", async () => {
  const user = { id: "user-4", email: "new@example.com" };
  let signupPayload;
  const api = createAuthApi(
    createClient({
      signUp: async (value) => {
        signupPayload = value;
        return { data: { user, session: null }, error: null };
      },
    })
  );

  const result = await api.signUp(
    "New@Example.com",
    "password123",
    "https://example.com/"
  );

  assert.deepEqual(signupPayload, {
    email: "new@example.com",
    password: "password123",
    options: { emailRedirectTo: "https://example.com/" },
  });
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.session, null);
  assert.equal(result.user, user);
});

test("signup returns an immediate session when confirmation is disabled", async () => {
  const user = { id: "user-5", email: "new@example.com" };
  const session = { user };
  const api = createAuthApi(
    createClient({
      signUp: async () => ({ data: { user, session }, error: null }),
    })
  );

  const result = await api.signUp(
    "new@example.com",
    "password123",
    "https://example.com/"
  );

  assert.equal(result.confirmationRequired, false);
  assert.equal(result.session, session);
});

test("the complete confirmation flow restores the confirmed session after redirect", async () => {
  const user = { id: "user-6", email: "confirmed@example.com" };
  const signupApi = createAuthApi(
    createClient({
      signUp: async () => ({ data: { user, session: null }, error: null }),
    })
  );
  const signupResult = await signupApi.signUp(
    user.email,
    "password123",
    "https://example.com/"
  );

  assert.equal(signupResult.confirmationRequired, true);
  assert.equal(
    parseAuthRedirectHash(
      "#access_token=confirmed-access&refresh_token=confirmed-refresh&type=signup"
    )?.kind,
    "confirmation"
  );

  const confirmedSession = { user, access_token: "confirmed-access" };
  const restoredStates = [];
  const restoredApi = createAuthApi(
    createClient({
      getSession: async () => ({
        data: { session: confirmedSession },
        error: null,
      }),
    })
  );
  const observer = observeAuthSession(restoredApi, (state) =>
    restoredStates.push(state)
  );

  await observer.ready;

  assert.equal(restoredStates.length, 1);
  assert.equal(restoredStates[0].event, "RESTORED");
  assert.equal(restoredStates[0].session, confirmedSession);
  observer.stop();
});

test("local logout clears Supabase Auth without removing the separate Trakt token", async () => {
  const traktStorageKey = "london_screenings_trakt_token";
  const storage = new Map([[traktStorageKey, "stored-trakt-token"]]);
  const originalLocalStorage = globalThis.localStorage;
  let signOutOptions;

  globalThis.localStorage = {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    removeItem(key) {
      storage.delete(key);
    },
    setItem(key, value) {
      storage.set(key, value);
    },
  };

  try {
    const api = createAuthApi(
      createClient({
        signOut: async (options) => {
          signOutOptions = options;
          return { error: null };
        },
      })
    );

    await api.signOut();

    assert.deepEqual(signOutOptions, { scope: "local" });
    assert.equal(localStorage.getItem(traktStorageKey), "stored-trakt-token");
  } finally {
    if (originalLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = originalLocalStorage;
    }
  }
});

test("known and unexpected Auth failures are converted to friendly messages", async () => {
  const invalidCredentialsApi = createAuthApi(
    createClient({
      signInWithPassword: async () => ({
        data: null,
        error: {
          code: "invalid_credentials",
          message: "raw service detail",
        },
      }),
    })
  );

  await assert.rejects(
    invalidCredentialsApi.signIn("person@example.com", "wrong"),
    (error) =>
      error instanceof AuthUiError &&
      error.message === "Email or password is incorrect." &&
      !error.message.includes("raw service detail")
  );

  assert.equal(
    getAuthErrorMessage({ name: "AuthRetryableFetchError" }, "signup"),
    "The account service is temporarily unavailable. Please try again."
  );
});

test("the account form validates email and signup passwords", () => {
  assert.equal(
    validateAuthForm({ mode: "login", email: "invalid", password: "value" }),
    "Enter a valid email address."
  );
  assert.equal(
    validateAuthForm({
      mode: "signup",
      email: "person@example.com",
      password: "short",
      confirmPassword: "short",
    }),
    "Use at least 8 characters for your password."
  );
  assert.equal(
    validateAuthForm({
      mode: "signup",
      email: "person@example.com",
      password: "password123",
      confirmPassword: "password124",
    }),
    "The passwords do not match."
  );
});

test("email-confirmation redirects are recognised without treating Trakt query codes as Auth", () => {
  const success = parseAuthRedirectHash(
    "#access_token=access&refresh_token=refresh&type=signup"
  );
  const expired = parseAuthRedirectHash(
    "#error=access_denied&error_code=otp_expired&error_description=expired"
  );

  assert.deepEqual(success, {
    kind: "confirmation",
    message: "Email confirmed. You're now logged in.",
  });
  assert.equal(expired.kind, "error");
  assert.match(expired.message, /expired/i);
  assert.equal(parseAuthRedirectHash(""), null);
  assert.equal(parseAuthRedirectHash("#section=screenings"), null);
  assert.equal(parseAuthRedirectHash("?code=trakt-code&state=trakt-state"), null);
});

test("recovery redirects are recognised from the URL hash", () => {
  const recovery = parseAuthRedirectHash(
    "#access_token=recovery-access&refresh_token=recovery-refresh&type=recovery"
  );

  assert.deepEqual(recovery, {
    kind: "recovery",
    message: "Set a new password for your account.",
  });
});

test("resetPasswordForEmail normalises the email and passes the redirect URL", async () => {
  let resetPayload;
  const api = createAuthApi(
    createClient({
      resetPasswordForEmail: async (email, options) => {
        resetPayload = { email, options };
        return { error: null };
      },
    })
  );

  await api.resetPassword("  Person@Example.com ", "https://example.com/reset");

  assert.deepEqual(resetPayload, {
    email: "person@example.com",
    options: { redirectTo: "https://example.com/reset" },
  });
});

test("resetPasswordForEmail without a redirect URL omits options", async () => {
  let resetPayload;
  const api = createAuthApi(
    createClient({
      resetPasswordForEmail: async (email, options) => {
        resetPayload = { email, options };
        return { error: null };
      },
    })
  );

  await api.resetPassword("person@example.com");

  assert.equal(resetPayload.email, "person@example.com");
  assert.equal(resetPayload.options, undefined);
});

test("resetPasswordForEmail errors are converted to friendly messages", async () => {
  const api = createAuthApi(
    createClient({
      resetPasswordForEmail: async () => ({
        error: {
          code: "over_email_send_rate_limit",
          message: "raw rate limit detail",
        },
      }),
    })
  );

  await assert.rejects(
    api.resetPassword("person@example.com"),
    (error) =>
      error instanceof AuthUiError &&
      error.message ===
        "Too many confirmation emails were requested. Please wait before trying again." &&
      !error.message.includes("raw rate limit detail")
  );
});

test("updateUserPassword sends the new password and returns the updated user", async () => {
  let updatePayload;
  const updatedUser = { id: "user-7", email: "person@example.com" };
  const api = createAuthApi(
    createClient({
      updateUser: async (payload) => {
        updatePayload = payload;
        return { data: { user: updatedUser }, error: null };
      },
    })
  );

  const result = await api.updateUserPassword("newpassword123");

  assert.deepEqual(updatePayload, { password: "newpassword123" });
  assert.deepEqual(result, { user: updatedUser });
});

test("updateUserPassword errors are converted to friendly messages", async () => {
  const api = createAuthApi(
    createClient({
      updateUser: async () => ({
        data: null,
        error: {
          code: "weak_password",
          message: "raw weak password detail",
        },
      }),
    })
  );

  await assert.rejects(
    api.updateUserPassword("weak"),
    (error) =>
      error instanceof AuthUiError &&
      error.message ===
        "Choose a stronger password. Use at least 8 characters." &&
      !error.message.includes("raw weak password detail")
  );
});

test("validateResetEmailForm rejects invalid email addresses", () => {
  assert.equal(
    validateResetEmailForm({ email: "invalid" }),
    "Enter a valid email address."
  );
  assert.equal(
    validateResetEmailForm({ email: "" }),
    "Enter a valid email address."
  );
  assert.equal(
    validateResetEmailForm({ email: "person@example.com" }),
    ""
  );
});

test("validateUpdatePasswordForm enforces length and confirmation match", () => {
  assert.equal(
    validateUpdatePasswordForm({ password: "" }),
    "Enter your new password."
  );
  assert.equal(
    validateUpdatePasswordForm({ password: "short" }),
    "Use at least 8 characters for your password."
  );
  assert.equal(
    validateUpdatePasswordForm({
      password: "password123",
      confirmPassword: "password124",
    }),
    "The passwords do not match."
  );
  assert.equal(
    validateUpdatePasswordForm({
      password: "password123",
      confirmPassword: "password123",
    }),
    ""
  );
});
