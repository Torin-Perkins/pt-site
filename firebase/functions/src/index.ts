/**
 * Toro Fitness client & coach portal — Cloud Functions entry point.
 * See ../README.md for the data model, roles and setup.
 */
import { setGlobalOptions } from "firebase-functions/v2";
import { REGION } from "./config.js";

setGlobalOptions({ region: REGION, maxInstances: 10 });

export { onUserCreated, onUserDeleted, ensureProfile, setUserRole } from "./users.js";
export {
  setAvailability,
  getOpenSlots,
  requestSession,
  bookSession,
  respondToSession,
  cancelSession,
  completeSession,
} from "./scheduling.js";
export {
  createInvoice,
  voidInvoice,
  createCheckoutSession,
  createBillingPortalSession,
  syncBilling,
  lookupStripeProduct,
  assignMembership,
  setMembershipEnding,
  cleanupTestBillingData,
  stripeWebhook,
} from "./billing.js";
export { onSessionWritten } from "./notifications.js";
export { adjustCredits } from "./credits.js";
