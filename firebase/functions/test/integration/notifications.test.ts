/**
 * Session emails against the Firestore emulator (`npm run test:integration`).
 * Runs the same handler the onSessionWritten trigger calls. In the emulator,
 * emails are recorded in mailLog instead of being sent.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";

process.env.FUNCTIONS_EMULATOR = "true";
process.env.GCLOUD_PROJECT ??= "demo-toro";
process.env.APP_BASE_URL = "https://www.torofitness.com";
process.env.EMAIL_FROM = "Toro Fitness <coach@torofitness.com>";
process.env.STUDIO_LOCATION = "Online, via video call";

const { db } = await import("../../src/lib/firebase.js");
const { handleSessionChange } = await import("../../src/notifications.js");
import type { SessionDoc } from "../../src/scheduling.js";

const start = new Date(Date.now() + 3 * 86_400_000);
start.setUTCMinutes(0, 0, 0);
const session = (status: SessionDoc["status"], extra: Partial<SessionDoc> = {}): SessionDoc => ({
  clientId: "cara",
  clientName: "Cara Bennett",
  trainerId: "erica",
  trainerName: "Erica Hansen",
  start: Timestamp.fromDate(start),
  end: Timestamp.fromMillis(start.getTime() + 3_600_000),
  status,
  slotId: "erica_x",
  clientNote: "Deadlifts please",
  createdBy: "cara",
  ...extra,
});
const log = async (id: string) => (await db.doc(`mailLog/${id}`).get()).data();

beforeAll(async () => {
  await db.doc("users/cara").set({ displayName: "Cara Bennett", email: "cara@example.com", role: "client" });
  await db.doc("users/erica").set({ displayName: "Erica Hansen", email: "erica@example.com", role: "admin" });
  await db.doc("availability/erica").set({ timezone: "America/Los_Angeles", weekly: {}, cancellationWindowHours: 24 });
});

describe("session emails", () => {
  it("confirmation goes to client and trainer with calendar invites", async () => {
    await handleSessionChange("s1", session("requested"), session("confirmed", { trainerNote: "Bring water" }));
    const m = (await log("s1_confirmed"))!;
    expect(m.status).toBe("logged");
    expect(m.results).toHaveLength(2);
    const [client, trainer] = m.results;

    expect(client.to).toBe("cara@example.com");
    expect(client.subject).toMatch(/^Confirmed: training with Erica Hansen — \w+day, /);
    expect(client.text).toContain("Note from your coach: Bring water");
    expect(client.text).toContain("https://calendar.google.com/calendar/render?action=TEMPLATE");
    expect(client.text).toContain("https://outlook.live.com/calendar/0/deeplink/compose?");
    expect(client.text).toContain("24 hours' notice");
    expect(client.ics).toContain("METHOD:PUBLISH");
    expect(client.ics).toContain("SUMMARY:Personal training with Erica Hansen");
    expect(client.ics).toContain("LOCATION:Online\\, via video call");

    expect(trainer.to).toBe("erica@example.com");
    expect(trainer.subject).toMatch(/^Confirmed: Cara Bennett — /);
    expect(trainer.text).toContain("Client note: Deadlifts please");
    expect(trainer.ics).toContain("SUMMARY:Training: Cara Bennett");
  });

  it("sends each email only once", async () => {
    await handleSessionChange("s1", session("requested"), session("confirmed"));
    const m = (await log("s1_confirmed"))!;
    expect(m.results[0].text).toContain("Bring water"); // still the first send
  });

  it("direct bookings get a confirmation too", async () => {
    await handleSessionChange("s2", undefined, session("confirmed"));
    expect((await log("s2_confirmed"))?.results).toHaveLength(2);
  });

  it("cancelling a confirmed session sends a calendar cancellation", async () => {
    await handleSessionChange(
      "s1",
      session("confirmed"),
      session("cancelled", { cancelledBy: "cara", cancelReason: "Sick", lateCancellation: true }),
    );
    const [client, trainer] = (await log("s1_cancelled"))!.results;
    expect(client.subject).toMatch(/^Cancelled: training with Erica Hansen/);
    expect(client.text).toContain("You cancelled your session");
    expect(client.ics).toContain("METHOD:CANCEL");
    expect(client.ics).toContain("STATUS:CANCELLED");
    expect(trainer.text).toContain("Cara Bennett cancelled");
    expect(trainer.text).toContain("late cancellation");
    expect(trainer.text).toContain("Reason: Sick");
  });

  it("no email for requests, declines, completions or past sessions", async () => {
    await handleSessionChange("s3", undefined, session("requested"));
    await handleSessionChange("s3", session("requested"), session("declined"));
    await handleSessionChange("s4", session("confirmed"), session("completed"));
    const past = Timestamp.fromMillis(Date.now() - 2 * 86_400_000);
    await handleSessionChange("s5", session("requested"), session("confirmed", { start: past, end: past }));
    for (const id of ["s3_confirmed", "s3_cancelled", "s4_confirmed", "s4_cancelled", "s5_confirmed"]) {
      expect(await log(id)).toBeUndefined();
    }
  });

  it("skips a person with no email address", async () => {
    await db.doc("users/noemail").set({ displayName: "No Email", role: "client" });
    await handleSessionChange("s6", undefined, session("confirmed", { clientId: "noemail", clientName: "No Email" }));
    const m = (await log("s6_confirmed"))!;
    expect(m.results).toHaveLength(1);
    expect(m.results[0].to).toBe("erica@example.com");
  });
});
