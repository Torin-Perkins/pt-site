# Toro Fitness portal backend (Firebase)

Backend for the client & trainer portal: Firebase Auth for sign-in, Firestore for
data, Cloud Functions for anything with business rules (roles, scheduling,
billing), and Stripe for payments. None of this folder is published with the
marketing site (the Flask app only serves `portal/dist`).

```
firebase/
  firebase.json            Firebase config (Firestore, Functions, emulators)
  .firebaserc              Firebase project id
  firestore.rules          Security rules — who can read/write what
  firestore.indexes.json   Composite indexes the queries need
  functions/               Cloud Functions (TypeScript)
    src/users.ts           roles
    src/scheduling.ts      availability, session requests, booking
    src/billing.ts         Stripe invoices, checkout, portal, webhook
    src/lib/schedule.ts    pure time-slot logic (unit tested)
    scripts/set-role.mjs   make the first admin from the command line
    test/                  unit, security-rules and end-to-end tests
```

## Roles

Every account has one role, stored as a `role` custom claim on the Firebase
Auth token (security rules check it) and mirrored on `users/{uid}.role`.
Only Cloud Functions can set it.

| Role | Can |
| --- | --- |
| **client** (default for every new account) | Browse every published workout; see their own assigned workouts and nutrition plans; log workouts, food and check-ins (weight, sleep, energy…); request 1-hour sessions and cancel their own; see their invoices, buy packages/memberships, manage cards |
| **trainer** | Everything about clients: create/edit workouts, assign them, write nutrition plans, read client logs and leave feedback, keep private notes; publish availability; confirm/decline/book/cancel/complete sessions; invoice clients |
| **admin** | Everything a trainer can, plus change roles and manage the billing catalog (`billingPlans`). Your own account would normally be admin. |

Trainers can see all clients — a small business where every coach works with
everyone. If that changes, scope reads in `firestore.rules` to a
`users/{uid}.trainerIds` list.

## Data model

| Path | Written by | Contents |
| --- | --- | --- |
| `users/{uid}` | functions; client edits own profile fields | email, displayName, role, phone, goals, emergencyContact, timezone |
| `users/{uid}/workoutLogs/{id}` | client, or a coach during a session (trainers may add `trainerComment` to any) | date, workoutId, exercises & sets, rpe, notes; coach-logged entries also have `loggedBy`, `loggedByName`, `sessionId`, `status: in_progress \| completed` and can't be edited or deleted by the client |
| `users/{uid}/nutritionLogs/{id}` | client (+ trainer feedback) | date, meals, totals, water, notes |
| `users/{uid}/metrics/{id}` | client (+ trainer feedback) | date, weight, measurements, sleep, energy, mood, symptoms |
| `clientNotes/{clientId}` | staff only | private trainer notes |
| `trainers/{uid}` | functions; trainer edits own bio | public coach directory |
| `workouts/{id}` | staff | title, exercises, level, published… — clients see every `published: true` workout |
| `assignments/{id}` | staff; client marks complete | clientId, workoutId, dueDate |
| `nutritionPlans/{id}` | staff | clientId, calories, macros, meals, guidelines |
| `recipes/{id}` | staff | shared meal ideas |
| `availability/{trainerId}` | `setAvailability` | time zone, weekly windows, blackout dates, booking rules |
| `sessions/{id}` | scheduling functions | clientId, trainerId, start, end, status, notes |
| `slots/{trainerId_block}` | scheduling functions | one doc per booked 15-minute block (`{ start, end, sessionId }` of the session covering it) — prevents overlapping bookings |
| `billing/{uid}` | functions | Stripe customer id per mode (`stripeCustomerId` for test, `stripeCustomerIdLive` for live), `sessionCredits` balance |
| `membershipAssignments/{clientId}` | functions | the membership tier a coach assigned: `{ planId, planName, status: pending \| active \| withdrawn, assignedBy }` |
| `creditLedger/{id}` | functions | every change to a client's session credits (payment, booking, refund, manual adjustment) |
| `invoices/{id}`, `subscriptions/{id}`, `purchases/{id}` | functions / Stripe webhook | read-only mirrors of Stripe |
| `billingPlans/{id}` | admin | `{ name, description, priceDisplay, stripeProductId, mode: "payment" \| "subscription", sessionCredits, active }` — checkout charges the product's current default price; older plans may have a fixed `stripePriceId` instead |
| `mailLog/{sessionId}_{kind}` | email trigger | record of each session email (who, subject, sent/failed); not readable from the app |

The field lists for each collection are documented in `firestore.rules`.

## Cloud Functions

All are callable functions (`httpsCallable(functions, name)`) in `us-west1`,
except the auth triggers and the Stripe webhook.

| Function | Who | What |
| --- | --- | --- |
| `ensureProfile` | anyone signed in | Call after sign-up/sign-in: creates the profile, assigns `client` if no role yet. If it returns `refreshToken: true`, call `user.getIdToken(true)`. |
| `setUserRole` `{ email \| uid, role }` | admin | Change someone's role |
| `setAvailability` `{ timezone, weekly, blackoutDates, minNoticeHours, maxDaysAhead, cancellationWindowHours, acceptingRequests, slotStepMinutes }` | trainer | Publish hours, e.g. `weekly: { mon: [{ start: "06:00", end: "12:00" }] }` |
| `getOpenSlots` `{ trainerId, from, to }` | anyone signed in | Open 1-hour start times (≤ 31 days per call) |
| `requestSession` `{ trainerId, start, note }` | client | Request a 1-hour block → `requested` |
| `respondToSession` `{ sessionId, action: "confirm" \| "decline", note }` | trainer | Confirm (locks the hour) or decline |
| `bookSession` `{ clientId, start, note }` | trainer | Put a confirmed session straight on the calendar |
| `cancelSession` `{ sessionId, reason }` | client, trainer | Cancel and free the hour; client cancels inside the window are flagged `lateCancellation` |
| `completeSession` `{ sessionId, outcome: "completed" \| "no_show" }` | trainer | After the session starts |
| `createInvoice` `{ clientId, items: [{ description, unitAmount, quantity }], daysUntilDue, memo, sessionId }` | trainer | Stripe emails the client an invoice with a pay link (amounts in cents) |
| `voidInvoice` `{ invoiceId }` | trainer | Void an open invoice |
| `assignMembership` `{ clientId, planId }` | trainer | Put a client on a membership tier. No membership yet: records a pending assignment and emails the client to add a card (Stripe Checkout for that tier only; charged automatically after that). Existing member: switches their Stripe subscription to the new tier from the next renewal |
| `setMembershipEnding` `{ clientId, ending }` | trainer | End a membership at the end of the current period (or undo that); withdraws a tier the client hasn't signed up for yet |
| `createCheckoutSession` `{ planId }` | client | Returns a Stripe Checkout URL for a `billingPlans` package or membership |
| `createBillingPortalSession` | client | Returns a Stripe portal URL (cards, receipts, cancel membership) |
| `adjustCredits` `{ clientId, change, note }` | trainer | Add or remove session credits by hand (comps, corrections); can't go below 0 |
| `lookupStripeProduct` `{ productId }` | admin | Reads a Stripe product (name, description, current price, one-off or recurring) for the plan form's *Fill from Stripe* |
| `cleanupTestBillingData` `{ dryRun }` | admin | After switching to the live Stripe key: checks each billing record against live Stripe and removes ones that only exist in test mode, plus credits granted by test payments (never below zero). Portal: Billing → Packages & memberships → Clean up test data. |
| `syncBilling` `{ clientId? }` | client (own), trainer | Copies the client's subscriptions and recent invoices from Stripe. The client Billing page runs it on every visit; trainers have *Refresh from Stripe* on a client's Billing tab. Catches up if a webhook was missed. |
| `stripeWebhook` (HTTPS) | Stripe | Keeps `invoices`, `subscriptions`, `purchases` in sync |
| `onSessionWritten` (Firestore trigger) | automatic | Emails the client and trainer when a session is confirmed or a confirmed one is cancelled (see below) |

**Scheduling rules.** Sessions are exactly one hour and can start every 15
minutes by default (`slotStepMinutes`: 15, 30 or 60, set per trainer under
Availability) in the trainer's time zone, inside a published window, not on a
blackout date, at least `minNoticeHours` ahead (default 12) and at most
`maxDaysAhead` (default 60). A confirmed session locks each 15-minute block it
covers, and confirming or booking checks the blocks up to an hour before too,
so sessions can never overlap (sessions booked before quarter-hour starts only
locked their first block; the overlap check still sees them). Open times
leave out any start that would overlap a booked session. A client can have at
most 5 pending requests and can't overlap their own sessions. Several clients
may request overlapping times; the first one confirmed wins and the rest can't
be confirmed. Session status flow:
`requested → confirmed → completed | no_show`, or `declined` / `cancelled`.

**Session credits.** Each 1-hour session uses one credit.
- Credits come from billing plans: each plan has `sessionCredits`. A
  membership adds them every time a payment goes through (each renewal;
  unused credits roll over). A package adds them once when paid. Credits are
  added when Stripe reports the invoice as paid — via the webhook or
  `syncBilling`, once per invoice either way.
- Requesting a session takes a credit straight away, so clients can only
  have as many sessions requested/booked as they have credits; with none they
  can't request. Trainers booking directly use a credit if the client has one,
  otherwise the session is booked without one (shown as "no credit used") and
  can be invoiced.
- The credit comes back when a request is declined or withdrawn, when the
  trainer cancels, or when the client cancels outside the cancellation
  window. A late cancellation or a no-show keeps the credit.
- **Membership tiers are assigned by trainers/admins** (client → Billing tab →
  Memberships). Clients can't pick a tier: the Billing page only offers
  one-time packages, plus the tier their coach assigned (*Add your card &
  start*). The backend enforces this in `createCheckoutSession`.
  `membershipAssignments/{clientId}` records the tier: `pending` → `active`
  once they've signed up (or `withdrawn`).
- Clients with a current membership see only their membership on the Billing
  page; they update their card or see receipts in Stripe's portal.

**Logging a session.** Confirmed sessions show **Log workout** from 30
minutes before they start (trainer Home, Schedule, the client's Sessions tab),
and each client's Workouts tab has **Log a workout**. The coach can start
from an assigned or library workout, then tick sets off as they go; the log is
saved automatically every couple of seconds, so a locked tablet or reload
loses nothing, and reopening the session returns to the same log. **Finish**
fills in the duration from the timer and marks the session completed. The
client sees it in their log as "Logged by … during the session".

**Session emails.** When a session becomes confirmed (a trainer confirms a
request or books one directly), the client and the trainer each get an email
with *Add to Google Calendar* and *Add to Outlook* buttons and an attached
`session.ics` invite (desktop Outlook, Apple Calendar, etc.), plus a one-hour
reminder. Cancelling a confirmed session emails a cancellation whose `.ics`
removes the event. Replies go to the other person. Emails are sent with
[Resend](https://resend.com); each one is recorded in `mailLog/{sessionId}_{kind}`
so it goes out once. Declined/withdrawn requests send nothing.

## One-time setup

1. **Create the Firebase project** at <https://console.firebase.google.com>
   (e.g. `toro-fitness`). Firebase may add a suffix to the id (like `toro-fitness-a1b2c`);
   put the exact project id in `.firebaserc`. Upgrade to the
   **Blaze** plan — Cloud Functions and secrets need it; this usage stays
   within the free allowance.
2. **Authentication** → enable *Email/Password* (and *Google* if wanted).
   Add the site's domain under *Settings → Authorized domains*.
3. **Firestore** → create the database in `us-west1` (Oregon).
4. **Stripe** — create an account, then:
   ```bash
   cd firebase/functions && npm install
   npx firebase login
   npx firebase functions:secrets:set STRIPE_SECRET_KEY --config ../firebase.json
   # The webhook's secret doesn't exist until step 7; enter "placeholder" for now
   # (the first deploy needs every secret the functions use to exist).
   npx firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --config ../firebase.json
   ```
   Use a `sk_test_…` key until everything is checked, then switch to live.
   In Stripe → *Settings → Billing → Customer portal*, turn the portal on,
   and leave **Customers can switch plans** off — membership tiers are
   assigned by coaches in the portal. (Decide whether clients may cancel
   there themselves; coaches can also end memberships from the portal.)
5. **Email (Resend)** — for the session confirmation emails:
   1. Sign up at <https://resend.com> (free up to 3,000 emails/month).
   2. *Domains → Add domain* → your domain, then add the DNS records
      it shows at your domain registrar and wait for it to say *Verified*.
   3. *API Keys → Create API key* (sending access), then:
      ```bash
      npx firebase functions:secrets:set RESEND_API_KEY --config ../firebase.json
      ```
      Not ready yet? Enter `disabled` — everything else works and no emails are sent.
   4. The first deploy asks for your site address and sender (it saves your
      answers in `functions/.env.<project-id>`; you can also create that file first):
      ```
      APP_BASE_URL=https://www.yourdomain.com
      EMAIL_FROM=Toro Fitness <coach@yourdomain.com>
      STUDIO_LOCATION=Online, via video call
      ```
      `EMAIL_FROM` must use the domain verified in Resend. `STUDIO_LOCATION` is
      the location on calendar invites — e.g. your video-call link, or a gym
      address for in-person sessions.
6. **Deploy**:
   ```bash
   npm run deploy
   ```
   `APP_BASE_URL` (where Stripe and the emails link back to) is your site's
   address; change it later in `functions/.env.<project-id>`. The email trigger has to run in the
   same region as the Firestore database (`us-west1`); if the deploy complains
   about the trigger's location, the database is somewhere else — change
   `REGION` in `functions/src/config.ts` to match.
7. **Stripe webhook** — Stripe → *Developers → Webhooks → Add endpoint* with the
   `stripeWebhook` URL printed by the deploy. Events: `invoice.*`,
   `customer.subscription.*`, `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`. Save its signing secret, then:
   ```bash
   npx firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --config ../firebase.json
   npm run deploy
   ```
8. **First admin** — sign up in the portal once with your own account, then:
   ```bash
   gcloud auth application-default login
   npm run set-role -- you@example.com admin --project <project-id>
   ```
   From then on, admins promote trainers with `setUserRole`.
9. **Packages / memberships** — create each product in Stripe (Product catalog →
   Add product, with a one-off or recurring price). In the portal, Billing →
   Packages & memberships → Add, paste the product ID (`prod_…`), click
   **Fill from Stripe**, set the session credits and save. To change a price
   later, add a new price to the product in Stripe and make it the default:
   new purchases use it straight away (existing members stay on their price
   until you move them in Stripe).

## Test mode vs live mode

The backend tells test and live mode apart from the Stripe key (`sk_live_…` is
live) and keeps a separate Stripe customer per client for each mode, so test
customers are never used with the live key. A stored customer that no longer
exists in Stripe is replaced automatically. After switching to live, an admin
runs **Billing → Packages & memberships → Clean up test data** (Preview, then
Remove) to clear test memberships, invoices and credits.

## Troubleshooting: payments show in Stripe but not in the portal

The portal's copy of invoices and memberships comes from the Stripe webhook
(and the catch-up `syncBilling`). If Stripe shows a payment the portal doesn't:

1. **Stripe → Developers → Webhooks** (or *Workbench → Event destinations*) →
   your endpoint → recent deliveries:
   - **No endpoint, or no deliveries** — add it (setup step 7). Make sure you're
     in the same mode (Test / Live) as the payment.
   - **400 "Bad signature"** — `STRIPE_WEBHOOK_SECRET` isn't this endpoint's
     signing secret, *or* it was changed without redeploying. Functions read
     secrets at deploy time, so after `functions:secrets:set`, run `npm run deploy`.
   - **400 "Thin events aren't supported"** — edit the destination and choose the
     **Snapshot** payload style.
   - **404** — the URL is wrong; copy the `stripeWebhook` URL from the deploy
     output (`https://us-west1-<project>.cloudfunctions.net/stripeWebhook`).
   - **500** — open the function's logs: Firebase console → Functions →
     `stripeWebhook` → Logs.
2. Check the endpoint listens to `customer.subscription.*`, `invoice.*` and
   `checkout.session.completed`.
3. In Stripe, use **Resend** on a failed delivery once it's fixed. Opening the
   client's Billing page also pulls the latest from Stripe.

## Local development & tests

Requires Node 22 and Java 21 (for the emulators).

```bash
cd firebase/functions
npm install
printf 'STRIPE_SECRET_KEY=sk_test_placeholder\nSTRIPE_WEBHOOK_SECRET=whsec_placeholder\nRESEND_API_KEY=disabled\n' > .secret.local
npm run serve         # all emulators + UI at http://localhost:4000
npm test              # scheduling + calendar unit tests
npm run test:rules    # security rules against the Firestore emulator
npm run test:integration  # session emails against the Firestore emulator
npm run test:e2e      # functions end-to-end against Auth/Firestore/Functions emulators
```

In the emulators, session emails are never sent — open `mailLog` in the
emulator UI to see each one's text and `.ics`.

Billing calls need a real Stripe test key in `.secret.local` to run locally;
use the Stripe CLI (`stripe listen --forward-to …/stripeWebhook`) for webhooks.

## Front end

The portal app lives in [`../portal`](../portal/README.md). Notes for anyone
changing it:

- After sign-in it calls `ensureProfile`, then `getIdToken(true)` if asked, and
  listens to `users/{uid}`: when `claimsUpdatedAt` changes it refreshes the token,
  so a promotion to trainer takes effect without signing out.
- Firestore rules aren't filters: queries must include the matching condition,
  e.g. `where("published", "==", true)` on `workouts` for clients and
  `where("clientId", "==", uid)` on `sessions`, `nutritionPlans`, `invoices`.
