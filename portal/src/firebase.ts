import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

const env = import.meta.env;

/** False until the Firebase web config is filled in (see .env.production). */
export const isConfigured = Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID);
export const usingEmulators = env.VITE_USE_EMULATORS === "true";

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || "missing",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID || "missing",
  appId: env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, env.VITE_FUNCTIONS_REGION || "us-west1");

if (usingEmulators) {
  const host = window.location.hostname === "localhost" ? "localhost" : "127.0.0.1";
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(functions, host, 5001);
}

/** Calls a Cloud Function and returns its data. Errors carry a readable message. */
export async function call<T = unknown>(name: string, data?: unknown): Promise<T> {
  const res = await httpsCallable(functions, name)(data);
  return res.data as T;
}

/** Turns any thrown value into something to show the user. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code: string }).code);
    const friendly: Record<string, string> = {
      "auth/invalid-credential": "That email and password don't match.",
      "auth/wrong-password": "That email and password don't match.",
      "auth/user-not-found": "There's no account with that email.",
      "auth/email-already-in-use": "There's already an account with that email — try signing in.",
      "auth/weak-password": "Please choose a password with at least 6 characters.",
      "auth/invalid-email": "That email address doesn't look right.",
      "auth/too-many-requests": "Too many attempts. Please wait a minute and try again.",
      "auth/network-request-failed": "Can't reach the server — check your connection.",
      "permission-denied": "You don't have access to do that.",
    };
    if (friendly[code]) return friendly[code];
  }
  if (err instanceof Error && err.message) return err.message.replace(/^Firebase: /, "");
  return "Something went wrong. Please try again.";
}
