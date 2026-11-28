import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db, COL } from "./lib/firebase.js";
import {
  type CalendarEvent,
  buildIcs,
  describeTime,
  googleCalendarLink,
  outlookCalendarLink,
} from "./lib/calendar.js";
import { DEFAULT_CANCELLATION_WINDOW_HOURS } from "./lib/schedule.js";
import { appBaseUrl, EMAIL_FROM, REGION, RESEND_API_KEY, STUDIO_LOCATION } from "./config.js";
import type { SessionDoc } from "./scheduling.js";

/*
 * Session emails. When a session becomes confirmed (a trainer confirms a
 * request, or books it directly) the client and the trainer each get an email
 * with "Add to Google Calendar / Outlook" buttons and an .ics invite. When a
 * confirmed session is cancelled they get a cancellation that removes it.
 *
 * Mail goes through Resend (resend.com). In the emulator, or while the
 * RESEND_API_KEY secret is "disabled", emails are only recorded in mailLog.
 * mailLog/{sessionId}_{kind} also makes sure each email goes out once.
 */

type Kind = "confirmed" | "cancelled";

interface Person {
  name: string;
  email: string | null;
}

interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Calendar invite to attach (session emails). */
  ics?: string;
  icsMethod?: "PUBLISH" | "CANCEL";
}

// ---------------------------------------------------------------- sending

export function transport(): "resend" | "log" {
  if (process.env.FUNCTIONS_EMULATOR === "true") return "log";
  const key = RESEND_API_KEY.value();
  return !key || key === "disabled" || key === "placeholder" ? "log" : "resend";
}

export async function send(msg: OutgoingEmail): Promise<{ id: string | null }> {
  if (transport() === "log") return { id: null };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY.value()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_FROM.value(),
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      ...(msg.ics
        ? {
            attachments: [
              {
                filename: msg.icsMethod === "CANCEL" ? "cancelled-session.ics" : "session.ics",
                content: Buffer.from(msg.ics, "utf8").toString("base64"),
                content_type: `text/calendar; charset=utf-8; method=${msg.icsMethod ?? "PUBLISH"}`,
              },
            ],
          }
        : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.message ?? "send failed"}`);
  return { id: body.id ?? null };
}

// ---------------------------------------------------------------- content

export type { OutgoingEmail };

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const firstName = (name: string) => (name.includes("@") ? "" : name.split(" ")[0]);

export function button(href: string, label: string) {
  return `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:999px;background:#1e3a5f;color:#ffffff;font-weight:700;text-decoration:none;font-size:14px">${esc(label)}</a>`;
}

export function layout(heading: string, rows: string[], footer: string) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6f9;font-family:Helvetica,Arial,sans-serif;color:#1a2230">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
  <p style="font-weight:800;letter-spacing:.04em;color:#1e3a5f;margin:0 0 18px">TORO FITNESS</p>
  <div style="background:#ffffff;border:1px solid #e2e7ee;border-radius:16px;padding:24px">
    <h1 style="font-size:22px;margin:0 0 14px">${heading}</h1>
    ${rows.join("\n    ")}
  </div>
  <p style="font-size:12px;color:#5b6676;margin:16px 4px">${footer}</p>
</div></body></html>`;
}

export const para = (html: string) => `<p style="margin:0 0 12px;line-height:1.5">${html}</p>`;

interface Context {
  sessionId: string;
  s: SessionDoc;
  client: Person;
  trainer: Person;
  timeZone: string;
  cancellationWindowHours: number;
}

function events(c: Context): { forClient: CalendarEvent; forTrainer: CalendarEvent } {
  const base = {
    uid: `${c.sessionId}@toro-fitness`,
    start: c.s.start.toDate(),
    end: c.s.end.toDate(),
    location: STUDIO_LOCATION.value() || undefined,
  };
  const notes = [c.s.clientNote && `Client note: ${c.s.clientNote}`, c.s.trainerNote && `Coach note: ${c.s.trainerNote}`]
    .filter(Boolean)
    .join("\n");
  return {
    forClient: {
      ...base,
      title: `Personal training with ${c.trainer.name}`,
      description: [`1-hour coaching session with Toro Fitness.`, notes, `Manage: ${appBaseUrl()}/portal/schedule`].filter(Boolean).join("\n\n"),
    },
    forTrainer: {
      ...base,
      uid: `${c.sessionId}-coach@toro-fitness`,
      title: `Training: ${c.client.name}`,
      description: [notes, `Client: ${appBaseUrl()}/portal/clients/${c.s.clientId}?tab=sessions`].filter(Boolean).join("\n\n"),
    },
  };
}

function calendarButtons(e: CalendarEvent) {
  return `<p style="margin:18px 0 4px">${button(googleCalendarLink(e), "Add to Google Calendar")}${button(outlookCalendarLink(e), "Add to Outlook")}</p>
    <p style="margin:0 0 12px;font-size:13px;color:#5b6676">Using Outlook for work, Apple Calendar or another app? Open the attached <strong>session.ics</strong> file. <a href="${esc(outlookCalendarLink(e, "work"))}" style="color:#1e3a5f">Outlook (work/school account)</a></p>`;
}

export function confirmedEmails(c: Context): OutgoingEmail[] {
  const when = describeTime(c.s.start.toDate(), c.s.end.toDate(), c.timeZone);
  const where = STUDIO_LOCATION.value();
  const { forClient, forTrainer } = events(c);
  const out: OutgoingEmail[] = [];
  const base = appBaseUrl();

  if (c.client.email) {
    const hi = firstName(c.client.name);
    out.push({
      to: c.client.email,
      replyTo: c.trainer.email ?? undefined,
      subject: `Confirmed: training with ${c.trainer.name} — ${when}`,
      icsMethod: "PUBLISH",
      ics: buildIcs(forClient),
      text: [
        `Hi${hi ? ` ${hi}` : ""}, your session with ${c.trainer.name} is confirmed.`,
        `When: ${when}`,
        where ? `Where: ${where}` : "",
        c.s.trainerNote ? `Note from your coach: ${c.s.trainerNote}` : "",
        `Add to Google Calendar: ${googleCalendarLink(forClient)}`,
        `Add to Outlook: ${outlookCalendarLink(forClient)}`,
        `Need to cancel? Please give at least ${c.cancellationWindowHours} hours' notice: ${base}/portal/schedule`,
      ].filter(Boolean).join("\n\n"),
      html: layout(
        "Your session is confirmed",
        [
          para(`Hi${hi ? ` ${esc(hi)}` : ""}, your session with <strong>${esc(c.trainer.name)}</strong> is booked.`),
          para(`<strong>When:</strong> ${esc(when)}${where ? `<br><strong>Where:</strong> ${esc(where)}` : ""}`),
          c.s.trainerNote ? para(`<strong>Note from your coach:</strong> ${esc(c.s.trainerNote)}`) : "",
          calendarButtons(forClient),
          para(`Need to cancel? Please give at least ${c.cancellationWindowHours} hours' notice — <a href="${esc(base)}/portal/schedule" style="color:#1e3a5f">manage your sessions</a>.`),
        ],
        "You're getting this because you booked a session in the Toro Fitness client portal. Reply to reach your coach.",
      ),
    });
  }

  if (c.trainer.email) {
    out.push({
      to: c.trainer.email,
      replyTo: c.client.email ?? undefined,
      subject: `Confirmed: ${c.client.name} — ${when}`,
      icsMethod: "PUBLISH",
      ics: buildIcs(forTrainer),
      text: [
        `Session confirmed with ${c.client.name}.`,
        `When: ${when}`,
        c.s.clientNote ? `Client note: ${c.s.clientNote}` : "",
        `Add to Google Calendar: ${googleCalendarLink(forTrainer)}`,
        `Add to Outlook: ${outlookCalendarLink(forTrainer)}`,
        `Client page: ${base}/portal/clients/${c.s.clientId}?tab=sessions`,
      ].filter(Boolean).join("\n\n"),
      html: layout(
        `Session with ${esc(c.client.name)}`,
        [
          para(`<strong>When:</strong> ${esc(when)}`),
          c.s.clientNote ? para(`<strong>Client note:</strong> “${esc(c.s.clientNote)}”`) : "",
          calendarButtons(forTrainer),
          para(`<a href="${esc(base)}/portal/clients/${esc(c.s.clientId)}?tab=sessions" style="color:#1e3a5f">Open ${esc(c.client.name)}'s page</a>`),
        ],
        "Sent by the Toro Fitness client portal. Reply to reach the client.",
      ),
    });
  }
  return out;
}

export function cancelledEmails(c: Context): OutgoingEmail[] {
  const when = describeTime(c.s.start.toDate(), c.s.end.toDate(), c.timeZone);
  const { forClient, forTrainer } = events(c);
  const byClient = c.s.cancelledBy === c.s.clientId;
  const reason = c.s.cancelReason ? `Reason: ${c.s.cancelReason}` : "";
  const base = appBaseUrl();
  const out: OutgoingEmail[] = [];

  if (c.client.email) {
    const who = byClient ? "You cancelled" : `${c.trainer.name} cancelled`;
    out.push({
      to: c.client.email,
      replyTo: c.trainer.email ?? undefined,
      subject: `Cancelled: training with ${c.trainer.name} — ${when}`,
      icsMethod: "CANCEL",
      ics: buildIcs(forClient, { cancel: true }),
      text: [`${who} your session on ${when}.`, reason, `Book another time: ${base}/portal/schedule`].filter(Boolean).join("\n\n"),
      html: layout(
        "Session cancelled",
        [
          para(`${esc(who)} your session on <strong>${esc(when)}</strong>.`),
          reason ? para(esc(reason)) : "",
          para(`Open the attached file to remove it from your calendar. <a href="${esc(base)}/portal/schedule" style="color:#1e3a5f">Book another time</a>.`),
        ],
        "Sent by the Toro Fitness client portal.",
      ),
    });
  }

  if (c.trainer.email) {
    const who = byClient ? `${c.client.name} cancelled` : "Cancelled";
    const late = byClient && c.s.lateCancellation ? " This was a late cancellation — you can invoice it from the client's Billing tab." : "";
    out.push({
      to: c.trainer.email,
      replyTo: c.client.email ?? undefined,
      subject: `Cancelled: ${c.client.name} — ${when}`,
      icsMethod: "CANCEL",
      ics: buildIcs(forTrainer, { cancel: true }),
      text: [`${who}: session on ${when}.${late}`, reason].filter(Boolean).join("\n\n"),
      html: layout(
        `Cancelled: ${esc(c.client.name)}`,
        [
          para(`${esc(who)}: session on <strong>${esc(when)}</strong>.${esc(late)}`),
          reason ? para(esc(reason)) : "",
          para(`The hour is open again. Open the attached file to remove it from your calendar.`),
        ],
        "Sent by the Toro Fitness client portal.",
      ),
    });
  }
  return out;
}

// ---------------------------------------------------------------- trigger

async function person(uid: string, fallbackName: string | null): Promise<Person> {
  const snap = await db.collection(COL.users).doc(uid).get();
  return {
    name: (snap.get("displayName") as string | undefined) || fallbackName || (snap.get("email") as string | undefined) || "Toro Fitness client",
    email: (snap.get("email") as string | undefined) ?? null,
  };
}

/** Decides which email (if any) a change to a session calls for. */
export function emailKind(before: SessionDoc | undefined, after: SessionDoc | undefined): Kind | null {
  if (!after) return null;
  if (after.status === "confirmed" && before?.status !== "confirmed") return "confirmed";
  if (after.status === "cancelled" && before?.status === "confirmed") return "cancelled";
  return null;
}

/** Sends the emails a session change calls for (at most once per session and kind). */
export async function handleSessionChange(sessionId: string, before: SessionDoc | undefined, after: SessionDoc | undefined): Promise<void> {
    const kind = emailKind(before, after);
    if (!kind || !after) return;
    if (after.start.toMillis() < Date.now() - 3_600_000) return; // old session, nothing to put on a calendar

    const logRef = db.collection(COL.mailLog).doc(`${sessionId}_${kind}`);
    try {
      await logRef.create({ sessionId, kind, status: "sending", createdAt: FieldValue.serverTimestamp() });
    } catch {
      return; // already sent (trigger delivered twice)
    }

    const [client, trainer, availability] = await Promise.all([
      person(after.clientId, after.clientName),
      person(after.trainerId, after.trainerName),
      db.collection(COL.availability).doc(after.trainerId).get(),
    ]);
    const ctx: Context = {
      sessionId,
      s: after,
      client,
      trainer,
      timeZone: (availability.get("timezone") as string | undefined) ?? "America/Los_Angeles",
      cancellationWindowHours: (availability.get("cancellationWindowHours") as number | undefined) ?? DEFAULT_CANCELLATION_WINDOW_HOURS,
    };
    const emails = kind === "confirmed" ? confirmedEmails(ctx) : cancelledEmails(ctx);
    const mode = transport();

    const results = await Promise.all(
      emails.map(async (m) => {
        try {
          const { id } = await send(m);
          return { to: m.to, subject: m.subject, ok: true, id, ...(mode === "log" ? { text: m.text, ics: m.ics } : {}) };
        } catch (err) {
          logger.error("Session email failed", { sessionId, kind, to: m.to, err: (err as Error).message });
          return { to: m.to, subject: m.subject, ok: false, error: (err as Error).message };
        }
      }),
    );
    await logRef.update({
      status: results.every((r) => r.ok) ? (mode === "log" ? "logged" : "sent") : "failed",
      transport: mode,
      results,
      finishedAt: FieldValue.serverTimestamp(),
    });
    logger.info("Session emails", { sessionId, kind, transport: mode, sent: results.filter((r) => r.ok).length });
}

export const onSessionWritten = onDocumentWritten(
  { document: "sessions/{sessionId}", region: REGION, secrets: [RESEND_API_KEY] },
  (event) =>
    handleSessionChange(
      event.params.sessionId,
      event.data?.before.data() as SessionDoc | undefined,
      event.data?.after.data() as SessionDoc | undefined,
    ),
);
