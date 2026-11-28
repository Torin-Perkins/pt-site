import { defineSecret, defineString } from "firebase-functions/params";

/** Cloud Functions region. */
export const REGION = "us-west1";

/** Stripe secret key (sk_live_… / sk_test_…). `firebase functions:secrets:set STRIPE_SECRET_KEY` */
export const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
/**
 * Whether the Stripe key is a live or a test key. Test and live mode are
 * separate worlds in Stripe (a test customer doesn't exist in live mode), so
 * each mode keeps its own customer id per client.
 */
export function stripeMode(): "live" | "test" {
  try {
    return /^(sk|rk)_live_/.test(STRIPE_SECRET_KEY.value() ?? "") ? "live" : "test";
  } catch {
    return "test";
  }
}

/** Field on billing/{uid} holding the client's Stripe customer id for the current mode. */
export const customerField = (): "stripeCustomerId" | "stripeCustomerIdLive" =>
  stripeMode() === "live" ? "stripeCustomerIdLive" : "stripeCustomerId";

/** Signing secret of the Stripe webhook endpoint (whsec_…). */
export const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

/** Where Stripe Checkout / the billing portal send people back to. */
// No default: `firebase deploy` asks for the site's real address the first time.
export const APP_BASE_URL = defineString("APP_BASE_URL", {
  description: "Your website's address, e.g. https://www.yourdomain.com (no trailing slash)",
});

/**
 * APP_BASE_URL as a full address. Stripe rejects return URLs without a
 * scheme, so "www.torofitness.com" becomes "https://www.torofitness.com"
 * (spaces, quotes and trailing slashes are dropped too).
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/^["']|["']$/g, "").trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, "")}`;
  return url.replace(/\/+$/, "");
}

export const appBaseUrl = (): string => normalizeBaseUrl(APP_BASE_URL.value());

export const CURRENCY = defineString("CURRENCY", { default: "usd" });

/** Resend (resend.com) API key for session emails. Set to "disabled" to turn emails off. */
export const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

/** Sender for session emails. Its domain must be verified in Resend. */
export const EMAIL_FROM = defineString("EMAIL_FROM", {
  description: 'From address for session emails, e.g. "Toro Fitness <coach@yourdomain.com>" (domain verified in Resend)',
});

/** Shown as the event location in calendar invites. Leave blank to omit. */
export const STUDIO_LOCATION = defineString("STUDIO_LOCATION", {
  default: "Online, via video call",
  description: "Where sessions happen, shown on calendar invites (e.g. a video-call note)",
});
