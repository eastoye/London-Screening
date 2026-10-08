import { useEffect, useId, useRef, useState } from "react";
import {
  getAuthErrorMessage,
  validateAuthForm,
  validateResetEmailForm,
  validateUpdatePasswordForm,
} from "./authApi.js";
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
  onResetPassword,
  onUpdatePassword,
  recoveryMode = false,
}) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);

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
    setResetSent(false);
    setShowForgotPassword(false);

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
    if (isOpen && isAuthenticated && !recoveryMode) {
      onClose();
    }
  }, [isAuthenticated, isOpen, onClose, recoveryMode]);

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
    setShowForgotPassword(false);

    window.setTimeout(() => emailRef.current?.focus(), 0);
  };

  const handleForgotPassword = () => {
    if (submittingRef.current) return;

    setError("");
    setPassword("");
    setConfirmPassword("");
    setShowForgotPassword(true);

    window.setTimeout(() => emailRef.current?.focus(), 0);
  };

  const handleBackToLogin = () => {
    if (submittingRef.current) return;

    setShowForgotPassword(false);
    setResetSent(false);
    setError("");

    window.setTimeout(() => emailRef.current?.focus(), 0);
  };

  const handleSendResetEmail = async (event) => {
    event.preventDefault();

    if (submittingRef.current) return;

    const validationError = validateResetEmailForm({ email });

    if (validationError) {
      setError(validationError);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError("");

    try {
      await onResetPassword(email.trim());
      setResetSent(true);
    } catch (resetError) {
      setError(getAuthErrorMessage(resetError, "recovery"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const handleUpdatePassword = async (event) => {
    event.preventDefault();

    if (submittingRef.current) return;

    const validationError = validateUpdatePasswordForm({
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
      await onUpdatePassword(password);
      onClose();
    } catch (updateError) {
      setError(getAuthErrorMessage(updateError, "updatePassword"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
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

  if (recoveryMode) {
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
            <div className="auth-intro">
              <span className="auth-eyebrow">Password recovery</span>
              <h2 id={titleId}>Set a new password</h2>
              <p id={descriptionId}>
                Choose a new password for your London Screenings account.
              </p>
            </div>

            <form className="auth-form" onSubmit={handleUpdatePassword} noValidate>
              <label>
                <span>New password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={submitting}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? messageId : undefined}
                />
              </label>

              <label>
                <span>Confirm new password</span>
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

              <p className="auth-password-hint">
                Use at least 8 characters.
              </p>

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
                {submitting ? "Updating password…" : "Update password"}
              </button>
            </form>
          </div>
        </section>
      </div>
    );
  }

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
          ) : showForgotPassword ? (
            resetSent ? (
              <div className="auth-confirmation" role="status">
                <span className="auth-eyebrow">Check your inbox</span>
                <h2
                  id={titleId}
                  ref={confirmationHeadingRef}
                  tabIndex="-1"
                >
                  Reset link sent
                </h2>
                <p id={descriptionId}>
                  If an account exists for <strong>{email.trim()}</strong>,
                  we&apos;ve sent a link to reset your password. Open it to
                  choose a new password.
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
                    onClick={handleBackToLogin}
                  >
                    Back to log in
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="auth-intro">
                  <span className="auth-eyebrow">Password recovery</span>
                  <h2 id={titleId}>Reset your password</h2>
                  <p id={descriptionId}>
                    Enter your email and we&apos;ll send you a link to set a
                    new password.
                  </p>
                </div>

                <form className="auth-form" onSubmit={handleSendResetEmail} noValidate>
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
                    {submitting ? "Sending reset link…" : "Send reset link"}
                  </button>
                </form>

                <p className="auth-separation-note">
                  <button
                    className="text-button"
                    type="button"
                    onClick={handleBackToLogin}
                    disabled={submitting}
                  >
                    Back to log in
                  </button>
                </p>
              </>
            )
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

                {mode === "login" && (
                  <button
                    className="auth-forgot-link"
                    type="button"
                    onClick={handleForgotPassword}
                    disabled={submitting}
                  >
                    Forgot your password?
                  </button>
                )}

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
