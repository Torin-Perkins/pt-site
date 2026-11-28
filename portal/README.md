# Toro Fitness client portal

The client & trainer web app, served at **`/portal/`** on the Toro Fitness site (the Flask app in the repo root
serves the built files from `portal/dist`).
React + TypeScript, built with Vite. It talks directly to the Firebase backend
in [`../firebase`](../firebase/README.md) (Auth, Firestore, Cloud Functions).

## What's in it

| Who | Pages |
| --- | --- |
| Everyone | Sign up / sign in / reset password, Home, Workouts library, Schedule, Billing, Profile |
| Clients | My log (workouts, meals, check-ins), Nutrition plan, request 1-hour sessions, pay invoices, buy packages/memberships |
| Trainers | Clients (profile, private notes, assigned workouts, nutrition plans, logs with feedback, sessions, invoices), workout editor, availability, confirm/decline/book/complete sessions, send invoices |
| Admins | Everything trainers have, plus Team & roles and the Packages & memberships catalog |

Source layout: `src/pages/` (one folder per area), `src/components/` (shared UI:
sessions, logs, invoices, slot picker), `src/auth.tsx` (sign-in state and role),
`src/firebase.ts` (SDK setup), `src/styles.css` (brand styles, shared with the
marketing site's palette).

## Run locally (against the emulators)

```bash
cd firebase/functions && npm install && npm run serve     # terminal 1: Firebase emulators
cd portal && npm install && npm run dev                   # terminal 2
```

Open <http://127.0.0.1:5173/portal/>. `.env.development` points the app at the
emulators. To try trainer pages, sign up, then make yourself admin from the
emulator UI (<http://127.0.0.1:4000> → Authentication → edit user → custom
claims `{"role":"admin"}`) — the portal picks it up after a refresh.

## Going live

1. Firebase console → Project settings → **Your apps → Add web app**. Copy the
   values into `.env.production` (these are public identifiers, safe to commit).
   Until they're filled in, `/portal/` shows "Client portal coming soon".
2. Firebase console → Authentication → Settings → **Authorized domains**: add
   the site's domain.
3. Rebuild and commit the app: `bash scripts/build-portal.sh` from the repo root,
   then commit `portal/dist`. The Flask app serves it at `/portal/`, and any
   `/portal/...` address (e.g. `/portal/billing?checkout=success`, where Stripe
   sends people after paying) loads the app.

`npm run build` type-checks and builds; `npm run typecheck` only type-checks.
