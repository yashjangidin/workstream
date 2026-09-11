import { useState, type FormEvent } from "react";
import { sendPasswordResetEmail, signInWithEmailAndPassword } from "firebase/auth";
import { firebaseAuth } from "./firebase";
import "./auth.css";

type Mode = "signin" | "signup" | "reset";
export function AuthPage() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const installerUrl = `${import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8080"}/downloads/WorkstreamSetup.exe`;
  const changeMode = (next: Mode) => { setMode(next); setError(""); setNotice(""); setPassword(""); };
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const normalizedEmail = email.trim().toLowerCase();
      if (mode === "signup") {
        const response = await fetch(`${import.meta.env.VITE_API_URL ?? ""}/v1/signup`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyName, ownerName, email: normalizedEmail, password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message ?? "Unable to create your account. Please try again.");
        setMode("signin"); setPassword(""); setNotice("Your account is ready. Sign in to start setting up your team.");
      } else if (mode === "reset") {
        await sendPasswordResetEmail(firebaseAuth, normalizedEmail);
        setNotice("If an account exists for this email, a password reset link has been sent. Check your inbox and spam folder.");
      } else {
        await signInWithEmailAndPassword(firebaseAuth, normalizedEmail, password);
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      const messages: Record<string, string> = {
        "auth/invalid-credential": "The email or password is incorrect. Please try again.",
        "auth/wrong-password": "The email or password is incorrect. Please try again.",
        "auth/user-not-found": "The email or password is incorrect. Please try again.",
        "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
        "auth/network-request-failed": "Unable to connect. Check your internet connection and try again.",
        "auth/invalid-api-key": "Account services are not configured yet. Please contact your administrator.",
        "auth/operation-not-allowed": "Email sign-in is not enabled yet. Please contact your administrator."
      };
      if (mode === "reset" && code === "auth/user-not-found") setNotice("If an account exists for this email, a password reset link has been sent. Check your inbox and spam folder.");
      else setError(code ? messages[code] ?? "Unable to complete this request. Please try again." : err instanceof Error ? err.message : "Unable to connect. Please try again.");
    } finally { setBusy(false); }
  }
  return <main className="auth-page">
    <div className="auth-story"><a className="auth-logo" href="/" aria-label="Workstream home"><span className="logo-mark">w</span>workstream<span className="logo-dot">.</span></a>
      <div className="auth-story-content"><p className="auth-kicker">A CLEARER WORKDAY</p><h1>Good work starts<br />with clarity.</h1><p>Bring your team’s time into focus. One place to understand the workday and keep everyone on the same page.</p>
        <div className="story-bottom-row"><div className="story-features"><span>01 <strong>Understand your team’s time</strong></span><span>02 <strong>Set clear daily expectations</strong></span><span>03 <strong>Keep progress in perspective</strong></span></div><a className="auth-download" href={installerUrl} download="WorkstreamSetup.exe"><span className="auth-download-icon">↓</span><span><strong>Download the app</strong><small>Windows desktop agent</small></span></a></div>
      </div><p className="auth-footnote">Thoughtful tools for the way teams work.</p></div>
    <section className="auth-panel" aria-labelledby="auth-title"><div className="auth-form-wrap">
      <p className="auth-kicker">YOUR WORKSTREAM WORKSPACE</p>
      <h2 id="auth-title">{mode === "signup" ? "Let’s get you started." : mode === "reset" ? "Forgot your password?" : "Welcome back."}</h2>
      <p className="auth-description">{mode === "signup" ? "Create an account for you and your company." : mode === "reset" ? "Enter your account email and we’ll send you a link to reset your password." : "Sign in to see how your team’s day is taking shape."}</p>
      {mode !== "reset" && <div className="auth-tabs"><button type="button" disabled={busy} aria-pressed={mode === "signin"} onClick={() => changeMode("signin")}>Sign in</button><button type="button" disabled={busy} aria-pressed={mode === "signup"} onClick={() => changeMode("signup")}>Create account</button></div>}
      <form onSubmit={submit}><fieldset disabled={busy}>
        {mode === "signup" && <><label htmlFor="company">Company name<input id="company" autoComplete="organization" placeholder="Your company" value={companyName} onChange={e => setCompanyName(e.target.value)} minLength={2} maxLength={120} required /></label><label htmlFor="owner">Owner name<input id="owner" autoComplete="name" placeholder="Your full name" value={ownerName} onChange={e => setOwnerName(e.target.value)} minLength={2} maxLength={120} required /></label></>}
        <label htmlFor="email">Email address<input id="email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} required /></label>
        {mode !== "reset" && <label htmlFor="password">Password<div className="password-field"><input id="password" type={showPassword ? "text" : "password"} autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder={mode === "signup" ? "At least 8 characters" : "Enter your password"} value={password} onChange={e => setPassword(e.target.value)} minLength={mode === "signup" ? 8 : undefined} maxLength={128} required /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? "Hide" : "Show"}</button></div></label>}
        {mode === "signin" && <div className="forgot-row"><button className="text-link" type="button" onClick={() => changeMode("reset")}>Forgot your password?</button></div>}
        {error && <p className="auth-error" role="alert">{error}</p>}{notice && <p className="auth-success" role="status">{notice}</p>}
        <button className="auth-submit" type="submit">{busy ? "Please wait…" : mode === "signup" ? "Create account →" : mode === "reset" ? "Send reset link →" : "Sign in →"}</button>
      </fieldset></form>
      <p className="auth-switch">{mode === "signup" ? "Already have an account? " : mode === "reset" ? "Ready to sign in? " : "New to Workstream? "}<button className="text-link" type="button" disabled={busy} onClick={() => changeMode(mode === "signin" ? "signup" : "signin")}>{mode === "signin" ? "Create an account" : "Back to sign in"}</button></p>
    </div><p className="auth-panel-footer">A little more clarity. Every workday.</p></section>
  </main>;
}
