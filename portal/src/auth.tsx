import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, call, db } from "./firebase";
import type { Role, UserProfile } from "./types";

interface AuthState {
  /** undefined while Firebase is still deciding whether someone is signed in. */
  user: User | null | undefined;
  role: Role | null;
  profile: UserProfile | null;
  ready: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>({
  user: undefined,
  role: null,
  profile: null,
  ready: false,
  signOut: async () => undefined,
});

export const useAuth = () => useContext(Ctx);

/** Like useAuth, but for pages that only render once someone is signed in. */
export function useSignedIn() {
  const a = useAuth();
  if (!a.user) throw new Error("useSignedIn used outside a signed-in route");
  return { ...a, user: a.user, uid: a.user.uid, role: a.role as Role };
}

async function readRole(user: User, force = false): Promise<Role | null> {
  const t = await user.getIdTokenResult(force);
  const r = t.claims.role;
  return r === "admin" || r === "trainer" || r === "client" ? r : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [role, setRole] = useState<Role | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [ready, setReady] = useState(false);
  const lastClaims = useRef<number | null>(null);

  useEffect(() => {
    let unsubProfile: (() => void) | undefined;
    const unsub = onAuthStateChanged(auth, async (u) => {
      unsubProfile?.();
      lastClaims.current = null;
      setUser(u);
      setProfile(null);
      if (!u) {
        setRole(null);
        setReady(true);
        return;
      }
      setReady(false);
      try {
        // Make sure the profile + role exist (new accounts), then refresh the token if needed.
        const res = await call<{ role: Role; refreshToken: boolean }>("ensureProfile");
        setRole(await readRole(u, res.refreshToken));
      } catch (err) {
        console.error("ensureProfile failed", err);
        setRole(await readRole(u, true));
      }
      // When an admin changes this person's role, claimsUpdatedAt changes: refresh the token.
      unsubProfile = onSnapshot(
        doc(db, "users", u.uid),
        async (snap) => {
          const data = snap.exists() ? ({ id: snap.id, ...snap.data() } as UserProfile) : null;
          setProfile(data);
          const stamp = data?.claimsUpdatedAt?.toMillis() ?? 0;
          if (lastClaims.current !== null && stamp !== lastClaims.current) setRole(await readRole(u, true));
          lastClaims.current = stamp;
          setReady(true);
        },
        () => setReady(true),
      );
    });
    return () => {
      unsub();
      unsubProfile?.();
    };
  }, []);

  return (
    <Ctx.Provider value={{ user, role, profile, ready: user === null || (user !== undefined && ready), signOut: () => signOut(auth) }}>
      {children}
    </Ctx.Provider>
  );
}
