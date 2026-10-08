const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const AUTH_ERROR_MESSAGES = new Map([
  ["email_address_invalid", "Enter a valid email address."],
  ["email_not_confirmed", "Confirm your email before logging in."],
  ["invalid_credentials", "Email or password is incorrect."],
  ["over_email_send_rate_limit", "Too many confirmation emails were requested. Please wait before trying again."],
  ["over_request_rate_limit", "Too many attempts were made. Please wait before trying again."],
  ["signup_disabled", "Account creation is temporarily unavailable."],
  ["user_already_exists", "An account already exists for this email. Log in instead."],
  ["user_already_registered", "An account already exists for this email. Log in instead."],
  ["validation_failed", "Check your email and password, then try again."],
  ["weak_password", "Choose a stronger password. Use at least 8 characters."],
]);

const CONTEXT_FALLBACKS = {
  login: "We couldn't log you in. Please try again.",
  logout: "We couldn't log you out. Please try again.",
  restore: "We couldn't restore your account session. You can still browse screenings.",
  signup: "We couldn't create your account. Please try again.",
};

export class AuthUiError extends Error {
  constructor(message, code = "auth_error") {
    super(message);
    this.name = "AuthUiError";
    this.code = code;
  }
}

export function getAuthErrorMessage(error, context = "login") {
  if (error instanceof AuthUiError) {
    return error.message;
  }

  const code = typeof error?.code === "string" ? error.code : "";
  const knownMessage = AUTH_ERROR_MESSAGES.get(code);

  if (knownMessage) {
    return knownMessage;
  }

  const errorName = typeof error?.name === "string" ? error.name : "";
  const status = Number(error?.status);

  if (
    errorName === "AuthRetryableFetchError" ||
    code === "request_timeout" ||
    status >= 500
  ) {
    return "The account service is temporarily unavailable. Please try again.";
  }

  return CONTEXT_FALLBACKS[context] || CONTEXT_FALLBACKS.login;
}

function authError(error, context) {
  return new AuthUiError(
    getAuthErrorMessage(error, context),
    typeof error?.code === "string" ? error.code : "auth_error"
  );
}

export function validateAuthForm({
  mode,
  email,
  password,
  confirmPassword = "",
}) {
  const cleanEmail = typeof email === "string" ? email.trim() : "";

  if (!EMAIL_PATTERN.test(cleanEmail)) {
    return "Enter a valid email address.";
  }

  if (typeof password !== "string" || password.length === 0) {
    return "Enter your password.";
  }

  if (mode === "signup" && password.length < 8) {
    return "Use at least 8 characters for your password.";
  }

  if (mode === "signup" && password !== confirmPassword) {
    return "The passwords do not match.";
  }

  return "";
}

export function parseAuthRedirectHash(hash) {
  if (typeof hash !== "string" || hash.length < 2) {
    return null;
  }

  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const errorCode = params.get("error_code");
  const error = params.get("error");

  if (errorCode || error) {
    const message =
      errorCode === "otp_expired"
        ? "This email confirmation link has expired or has already been used. Try logging in, or create the account again if it was not confirmed."
        : "We couldn't confirm your email. Please request a new confirmation email and try again.";

    return {
      kind: "error",
      message,
    };
  }

  const type = params.get("type");
  const hasSessionTokens =
    Boolean(params.get("access_token")) && Boolean(params.get("refresh_token"));

  if ((type === "signup" || type === "email") && hasSessionTokens) {
    return {
      kind: "confirmation",
      message: "Email confirmed. You're now logged in.",
    };
  }

  return null;
}

export function createAuthApi(client) {
  if (!client?.auth) {
    throw new TypeError("A Supabase client with Auth is required.");
  }

  return {
    async restoreSession() {
      const { data, error } = await client.auth.getSession();

      if (error) {
        throw authError(error, "restore");
      }

      return data?.session ?? null;
    },

    onAuthStateChange(callback) {
      const { data } = client.auth.onAuthStateChange((event, session) => {
        callback({
          event,
          session: session ?? null,
        });
      });

      return () => data.subscription.unsubscribe();
    },

    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });

      if (error) {
        throw authError(error, "login");
      }

      if (!data?.session?.user) {
        throw authError(null, "login");
      }

      return {
        session: data.session,
        user: data.session.user,
      };
    },

    async signUp(email, password, emailRedirectTo) {
      const options = emailRedirectTo ? { emailRedirectTo } : undefined;
      const { data, error } = await client.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        ...(options ? { options } : {}),
      });

      if (error) {
        throw authError(error, "signup");
      }

      if (!data?.user) {
        throw authError(null, "signup");
      }

      return {
        confirmationRequired: !data.session,
        session: data.session ?? null,
        user: data.user,
      };
    },

    async signOut() {
      const { error } = await client.auth.signOut({ scope: "local" });

      if (error) {
        throw authError(error, "logout");
      }
    },
  };
}

export function observeAuthSession(api, onStateChange) {
  let active = true;
  let authEventCount = 0;

  const unsubscribe = api.onAuthStateChange(({ event, session }) => {
    if (!active) return;

    authEventCount += 1;
    onStateChange({
      error: null,
      event,
      loading: false,
      session,
    });
  });

  const ready = api
    .restoreSession()
    .then((session) => {
      if (active && authEventCount === 0) {
        onStateChange({
          error: null,
          event: "RESTORED",
          loading: false,
          session,
        });
      }
    })
    .catch((error) => {
      if (active && authEventCount === 0) {
        onStateChange({
          error: authError(error, "restore"),
          event: "RESTORE_FAILED",
          loading: false,
          session: null,
        });
      }
    });

  return {
    ready,
    stop() {
      active = false;
      unsubscribe();
    },
  };
}
