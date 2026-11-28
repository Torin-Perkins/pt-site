import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import type { z } from "zod";

export const ROLES = ["admin", "trainer", "client"] as const;
export type Role = (typeof ROLES)[number];

/** Admins can do everything a trainer can. */
export const STAFF_ROLES: readonly Role[] = ["admin", "trainer"];

export interface Caller {
  uid: string;
  role: Role | null;
  email?: string;
  name?: string;
}

export function caller(request: CallableRequest): Caller {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const token = request.auth.token;
  const role = (ROLES as readonly string[]).includes(token.role) ? (token.role as Role) : null;
  return { uid: request.auth.uid, role, email: token.email, name: token.name };
}

export function requireRole(request: CallableRequest, ...allowed: Role[]): Caller & { role: Role } {
  const c = caller(request);
  if (!c.role || !allowed.includes(c.role)) {
    throw new HttpsError("permission-denied", "You don't have access to do that.");
  }
  return c as Caller & { role: Role };
}

export const isStaff = (role: Role | null): boolean => role !== null && STAFF_ROLES.includes(role);

/** Validates callable input with zod; turns failures into invalid-argument errors. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  // The Firebase client SDK sends `undefined` fields as null, and a call with
  // no data as null; treat them as absent.
  if (data === null || data === undefined) data = {};
  if (data && typeof data === "object" && !Array.isArray(data)) {
    data = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null));
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new HttpsError("invalid-argument", msg);
  }
  return result.data;
}
