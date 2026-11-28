import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
import { auth, call, errorMessage } from "../firebase";
import { useAuth } from "../auth";
import { Button, ErrorNote, TextInput } from "../components/ui";

function AuthShell({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <a href="/" className="auth-logo" aria-label="Toro Fitness home">
          <span className="toro-logo">TORO<span>FITNESS</span></span>
        </a>
        <h1>{title}</h1>
        {intro && <p className="muted">{intro}</p>}
        {children}
      </div>
    </div>
  );
}

function useAfterLogin() {
  const location = useLocation();
  return (location.state as { from?: string } | null)?.from ?? "/";
}

export function SignIn() {
  const { user } = useAuth();
  const next = useAfterLogin();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Welcome back" intro="Sign in to see your workouts, sessions and plan.">
      <form onSubmit={submit} className="stack">
        <TextInput label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextInput
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button type="submit" busy={busy} className="btn-block">Sign in</Button>
      </form>
      <p className="auth-links">
        <Link to="/reset">Forgot password?</Link>
        <span>New here? <Link to="/signup">Create an account</Link></span>
      </p>
    </AuthShell>
  );
}

export function SignUp() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user && !busy) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (name.trim()) {
        await updateProfile(cred.user, { displayName: name.trim() });
        await call("ensureProfile"); // copies the name onto the profile
      }
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create your account" intro="For Toro Fitness coaching clients. Your coach will see your logs, check-ins and sessions.">
      <form onSubmit={submit} className="stack">
        <TextInput label="Your name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <TextInput label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextInput
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          hint="At least 8 characters."
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button type="submit" busy={busy} className="btn-block">Create account</Button>
      </form>
      <p className="auth-links">
        <span>Already have an account? <Link to="/signin">Sign in</Link></span>
      </p>
    </AuthShell>
  );
}

export function ResetPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendPasswordResetEmail(auth, email.trim());
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Reset your password">
      {sent ? (
        <p>If there's an account for <strong>{email}</strong>, we've emailed a link to reset the password.</p>
      ) : (
        <form onSubmit={submit} className="stack">
          <TextInput label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button type="submit" busy={busy} className="btn-block">Send reset link</Button>
        </form>
      )}
      <p className="auth-links">
        <Link to="/signin">Back to sign in</Link>
      </p>
    </AuthShell>
  );
}
