import type { Timestamp } from "firebase/firestore";

export type Role = "admin" | "trainer" | "client";
export const isStaffRole = (r: Role | null | undefined) => r === "admin" || r === "trainer";

export interface UserProfile {
  id: string;
  email: string | null;
  displayName: string | null;
  role?: Role;
  phone?: string;
  goals?: string;
  emergencyContact?: string;
  timezone?: string;
  claimsUpdatedAt?: Timestamp;
  createdAt?: Timestamp;
  deleted?: boolean;
}

export interface TrainerProfile {
  id: string;
  displayName: string;
  bio?: string;
  specialties?: string[];
  active: boolean;
}

export interface Exercise {
  name: string;
  sets?: number | null;
  reps?: string;
  weight?: string;
  restSec?: number | null;
  notes?: string;
  videoUrl?: string;
}

export interface Workout {
  id: string;
  title: string;
  description?: string;
  category?: string;
  level?: string;
  durationMin?: number | null;
  equipment?: string[];
  exercises: Exercise[];
  published: boolean;
  createdBy: string;
  updatedAt?: Timestamp;
}

export interface Assignment {
  id: string;
  clientId: string;
  trainerId: string;
  workoutId: string;
  workoutTitle?: string;
  dueDate?: string | null;
  notes?: string;
  completedAt?: Timestamp | null;
  completedLogId?: string | null;
  clientNote?: string;
}

export interface Macros {
  proteinG?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
  fiberG?: number | null;
}

export interface Meal {
  name: string;
  time?: string;
  description?: string;
}

export interface NutritionPlan {
  id: string;
  clientId: string;
  trainerId: string;
  title: string;
  active: boolean;
  dailyCalories?: number | null;
  macros?: Macros;
  hydrationOz?: number | null;
  guidelines?: string;
  meals?: Meal[];
  supplements?: string[];
  startDate?: string | null;
  updatedAt?: Timestamp;
}

export interface LoggedSet {
  reps?: string;
  weight?: string;
  /** Ticked off during a coached session. */
  done?: boolean;
}
export interface LoggedExercise {
  name: string;
  sets: LoggedSet[];
  /** What was prescribed, e.g. "3 × 10 · 20 lb" (coach-logged sessions). */
  target?: string;
  notes?: string;
}

interface LogBase {
  id: string;
  date: string;
  notes?: string;
  trainerComment?: string;
  reviewedBy?: string;
  reviewedAt?: Timestamp;
  createdAt?: Timestamp;
}

export interface WorkoutLog extends LogBase {
  title: string;
  /** Set when a coach logged it (e.g. during a session). */
  loggedBy?: string;
  loggedByName?: string;
  sessionId?: string | null;
  status?: "in_progress" | "completed";
  workoutId?: string | null;
  assignmentId?: string | null;
  durationMin?: number | null;
  rpe?: number | null;
  exercises: LoggedExercise[];
}

export interface NutritionLog extends LogBase {
  meals: { name: string; description?: string; calories?: number | null; proteinG?: number | null }[];
  totals?: { calories?: number | null; proteinG?: number | null; carbsG?: number | null; fatG?: number | null };
  waterOz?: number | null;
}

export interface MetricsLog extends LogBase {
  weight?: number | null;
  unit?: "lb" | "kg";
  waistIn?: number | null;
  hipsIn?: number | null;
  sleepHours?: number | null;
  energy?: number | null;
  mood?: number | null;
  symptoms?: string[];
}

export type SessionStatus = "requested" | "confirmed" | "declined" | "cancelled" | "completed" | "no_show";

export interface Session {
  id: string;
  clientId: string;
  clientName: string | null;
  trainerId: string;
  trainerName: string | null;
  start: Timestamp;
  end: Timestamp;
  status: SessionStatus;
  clientNote?: string | null;
  trainerNote?: string | null;
  cancelReason?: string | null;
  lateCancellation?: boolean;
  invoiceId?: string | null;
  creditUsed?: boolean;
  creditRefunded?: boolean;
}

export interface TimeWindow {
  start: string;
  end: string;
}
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Availability {
  timezone: string;
  weekly: Partial<Record<Weekday, TimeWindow[]>>;
  blackoutDates?: string[];
  minNoticeHours?: number;
  maxDaysAhead?: number;
  cancellationWindowHours?: number;
  acceptingRequests?: boolean;
  /** Sessions may start every 15, 30 or 60 minutes. */
  slotStepMinutes?: 15 | 30 | 60;
}

export interface Invoice {
  id: string;
  clientId: string | null;
  number: string | null;
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | null;
  currency: string;
  total: number;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  description: string | null;
  lines: { description: string | null; amount: number }[];
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  dueDate: Timestamp | null;
  sessionId: string | null;
  stripeCreated?: Timestamp;
}

export interface Subscription {
  id: string;
  clientId: string | null;
  planId: string | null;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Timestamp | null;
  stripeCreated?: Timestamp | null;
}

export interface BillingPlan {
  id: string;
  name: string;
  description?: string;
  priceDisplay?: string;
  /** Stripe product (prod_…); checkout charges its current default price. */
  stripeProductId?: string;
  /** Older plans: a fixed Stripe price (price_…). Used only when there's no product. */
  stripePriceId?: string;
  mode: "payment" | "subscription";
  active: boolean;
  sort?: number;
  /** Session credits added per payment (each renewal, for a membership). */
  sessionCredits?: number;
}

export interface CreditEntry {
  id: string;
  clientId: string;
  change: number;
  balanceAfter: number;
  reason: "plan_payment" | "session_booked" | "session_refund" | "manual_adjustment";
  note: string | null;
  sessionId: string | null;
  invoiceId: string | null;
  planId: string | null;
  createdAt?: Timestamp;
}

/** Subscription statuses that count as "has a membership". */
export const CURRENT_SUB_STATUSES = ["active", "trialing", "past_due", "incomplete"];

/** A membership tier a coach assigned (membershipAssignments/{clientId}). */
export interface MembershipAssignment {
  id: string;
  clientId: string;
  planId: string;
  planName: string;
  status: "pending" | "active" | "withdrawn";
  assignedBy: string;
}
