import { useEffect, useId, useRef, useState } from "react";
import { getAuthErrorMessage, validateAuthForm } from "./authApi.js";
import "./AuthModal.css";

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export default function AuthModal({
  isAuthenticated,
  isOpen,
  onClose,
  onSignIn,
  onSignUp,
}) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState("");

  const dialogRef = useRef(null);
  const emailRef = useRef(null);
  const confirmationHeadingRef = useRef(null);
  const previousFocusRef = useRef(null);
  const submittingRef = useRef(false);

  const titleId = useId();
  const descriptionId = useId();
  const messageId = useId();

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  useEffect(() => {
    if (!isOpen) return undefined;

    previousFocusRef.current = document.activeElement;
    setMode("login");
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setError("");
    setSubmitting(false);
    setConfirmationEmail("");

    const focusTimer = window.setTimeout(() => {
      emailRef.current?.focus();
    }, 0);

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !submittingRef.current) {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );

      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen && isAuthenticated) {
      onClose();
    }
  }, [isAuthenticated, isOpen, onClose]);

  useEffect(() => {
    if (confirmationEmail) {
      confirmationHeadingRef.current?.focus();
    }
  }, [confirmationEmail]);

  if (!isOpen) return null;

  const close = () => {
    if (!submittingRef.current) {
      onClose();
    }
  };

  const selectMode = (nextMode) => {
    if (submittingRef.current) return;

    setMode(nextMode);
    setPassword("");
    setConfirmPassword("");
    setError("");
    setConfirmationEmail("");

    window.setTimeout(() => emailRef.current?.focus(), 0);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (submittingRef.current) return;

    const validationError = validateAuthForm({
      mode,
      email,
      password,
      confirmPassword,
    });

    if (validationError) {
      setError(validationError);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError("");

    try {
      if (mode === "signup") {
        const result = await onSignUp(email, password);

        if (result.confirmationRequired) {
          setConfirmationEmail(email.trim());
          setPassword("");
          setConfirmPassword("");
          return;
        }
      } else {
        await onSignIn(email, password);
      }

      onClose();
    } catch (submitError) {
      setError(
        getAuthErrorMessage(
          submitError,
          mode === "signup" ? "signup" : "login"
        )
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleBackdropPointerDown = (event) => {
    if (event.target === event.currentTarget) {
      close();
    }
  };

  return (
    <div className="auth-backdrop" onPointerDown={handleBackdropPointerDown}>
      <section
        ref={dialogRef}
        className="auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="auth-topbar">
          <span aria-hidden="true" />

          <button
            className="auth-icon-button"
            type="button"
            onClick={close}
            disabled={submitting}
            aria-label="Close account dialog"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="auth-content">
          {confirmationEmail ? (
            <div className="auth-confirmation" role="status">
              <span className="auth-eyebrow">Confirm your email</span>
              <h2
                id={titleId}
                ref={confirmationHeadingRef}
                tabIndex="-1"
              >
                Check your inbox
              </h2>
              <p id={descriptionId}>
                We sent a confirmation link to <strong>{confirmationEmail}</strong>.
                Open it to finish creating your London Screenings account.
              </p>
              <p>
                If an account already exists for that address, you can return
                here and log in instead.
              </p>

              <div className="auth-confirmation-actions">
                <button
                  className="auth-submit"
                  type="button"
                  onClick={close}
                >
                  Close
                </button>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => selectMode("login")}
                >
                  Return to log in
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="auth-intro">
                <span className="auth-eyebrow">London Screenings account</span>
                <h2 id={titleId}>
                  {mode === "signup" ? "Create your account" : "Log in"}
                </h2>
                <p id={descriptionId}>
                  {mode === "signup"
                    ? "Create an account with your email and password."
                    : "Use your London Screenings email and password."}
                </p>
              </div>

              <div className="auth-mode-switch" aria-label="Account action">
                <button
                  type="button"
                  className={mode === "login" ? "is-selected" : undefined}
                  aria-pressed={mode === "login"}
                  onClick={() => selectMode("login")}
                  disabled={submitting}
                >
                  Log in
                </button>
                <button
                  type="button"
                  className={mode === "signup" ? "is-selected" : undefined}
                  aria-pressed={mode === "signup"}
                  onClick={() => selectMode("signup")}
                  disabled={submitting}
                >
                  Create account
                </button>
              </div>

              <form className="auth-form" onSubmit={handleSubmit} noValidate>
                <label>
                  <span>Email</span>
                  <input
                    ref={emailRef}
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={submitting}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? messageId : undefined}
                  />
                </label>

                <label>
                  <span>Password</span>
                  <input
                    type="password"
                    autoComplete={
                      mode === "signup" ? "new-password" : "current-password"
                    }
                    minLength={mode === "signup" ? 8 : undefined}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={submitting}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? messageId : undefined}
                  />
                </label>

                {mode === "signup" && (
                  <label>
                    <span>Confirm password</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={8}
                      value={confirmPassword}
                      onChange={(event) =>
                        setConfirmPassword(event.target.value)
                      }
                      disabled={submitting}
                      aria-invalid={Boolean(error)}
                      aria-describedby={error ? messageId : undefined}
                    />
                  </label>
                )}

                {mode === "signup" && (
                  <p className="auth-password-hint">
                    Use at least 8 characters.
                  </p>
                )}

                {error && (
                  <div id={messageId} className="auth-error" role="alert">
                    {error}
                  </div>
                )}

                <button
                  className="auth-submit"
                  type="submit"
                  disabled={submitting}
                >
                  {submitting
                    ? mode === "signup"
                      ? "Creating account…"
                      : "Logging in…"
                    : mode === "signup"
                      ? "Create account"
                      : "Log in"}
                </button>
              </form>

              <p className="auth-separation-note">
                Your London Screenings account is separate from Trakt.
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
