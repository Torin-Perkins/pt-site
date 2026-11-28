import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

if (getApps().length === 0) initializeApp();

export const db = getFirestore();
export const auth = getAuth();

/** Collection names in one place so rules, functions and docs stay in sync. */
export const COL = {
  users: "users",
  trainers: "trainers",
  availability: "availability",
  sessions: "sessions",
  slots: "slots",
  billing: "billing",
  invoices: "invoices",
  subscriptions: "subscriptions",
  purchases: "purchases",
  billingPlans: "billingPlans",
  stripeEvents: "stripeEvents",
  mailLog: "mailLog",
  creditLedger: "creditLedger",
  membershipAssignments: "membershipAssignments",
} as const;
