import { useEffect, useState } from "react";
import { collection, limit, orderBy, query, where } from "firebase/firestore";
import { call, db } from "../firebase";
import { useClients } from "../lib/data";
import { useLiveQuery } from "../lib/useFirestore";
import { displayNameOf, fmtDateTime, money, parseDollars } from "../lib/format";
import { Button, Modal, Select, TextArea, TextInput, useAction } from "./ui";
import type { Session } from "../types";

interface Line {
  description: string;
  price: string;
  quantity: string;
}

const PRESETS = ["Personal training session (1 hour)", "Late cancellation fee", "No-show fee", "Nutrition coaching"];

/** Trainer/admin: create and send a Stripe invoice. */
export default function InvoiceModal({ open, onClose, clientId, session }: { open: boolean; onClose: () => void; clientId?: string; session?: Session | null }) {
  const clients = useClients();
  const [client, setClient] = useState(clientId ?? "");
  const [lines, setLines] = useState<Line[]>([]);
  const [daysUntilDue, setDays] = useState("7");
  const [memo, setMemo] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [run, busy] = useAction();
  const sessions = useLiveQuery<Session>(
    () => (client ? query(collection(db, "sessions"), where("clientId", "==", client), orderBy("start", "desc"), limit(15)) : null),
    [client],
  );

  useEffect(() => {
    if (!open) return;
    setClient(clientId ?? "");
    setSessionId(session?.id ?? "");
    setLines([{ description: session?.lateCancellation ? "Late cancellation fee" : PRESETS[0], price: "", quantity: "1" }]);
    setDays("7");
    setMemo("");
  }, [open, clientId, session]);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const items = lines.map((l) => ({ description: l.description.trim(), unitAmount: parseDollars(l.price), quantity: Math.max(1, Number(l.quantity) || 1) }));
  const valid = client && items.length > 0 && items.every((i) => i.description && i.unitAmount);
  const total = items.reduce((n, i) => n + (i.unitAmount ?? 0) * i.quantity, 0);
  const billable = sessions.data.filter((s) => !s.invoiceId && (s.status === "completed" || s.status === "no_show" || s.lateCancellation || s.status === "confirmed"));

  async function send() {
    if (!valid) return;
    const res = await run(
      () =>
        call<{ invoiceId: string }>("createInvoice", {
          clientId: client,
          items,
          daysUntilDue: Number(daysUntilDue) || 0,
          memo: memo.trim() || undefined,
          sessionId: sessionId || undefined,
        }),
      "Invoice sent — the client gets an email with a pay link.",
    );
    if (res) onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="New invoice"
      footer={
        <>
          <span className="muted">Total {money(total)}</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button busy={busy} disabled={!valid} onClick={send}>Send invoice</Button>
        </>
      }
    >
      <div className="stack">
        {!clientId && (
          <Select label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">Choose a client…</option>
            {clients.data.map((c) => <option key={c.id} value={c.id}>{displayNameOf(c)}</option>)}
          </Select>
        )}
        {lines.map((l, i) => (
          <div key={i} className="form-grid form-grid-4 line-edit">
            <TextInput label="Description" className="span-2" list="invoice-presets" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
            <TextInput label="Price ($)" inputMode="decimal" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} placeholder="85.00" />
            <div className="row">
              <TextInput label="Qty" type="number" min={1} max={100} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
              {lines.length > 1 && <button type="button" className="icon-btn" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button>}
            </div>
          </div>
        ))}
        <datalist id="invoice-presets">{PRESETS.map((p) => <option key={p} value={p} />)}</datalist>
        <div><Button size="sm" variant="secondary" onClick={() => setLines((ls) => [...ls, { description: "", price: "", quantity: "1" }])}>Add line</Button></div>
        <div className="form-grid">
          <TextInput label="Due in (days)" type="number" min={0} max={90} value={daysUntilDue} onChange={(e) => setDays(e.target.value)} />
          {client && (
            <Select label="For a session (optional)" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value="">—</option>
              {session && !billable.some((s) => s.id === session.id) && <option value={session.id}>{fmtDateTime(session.start)}</option>}
              {billable.map((s) => (
                <option key={s.id} value={s.id}>
                  {fmtDateTime(s.start)} · {s.lateCancellation ? "late cancel" : s.status.replace("_", " ")}
                </option>
              ))}
            </Select>
          )}
        </div>
        <TextArea label="Memo on the invoice (optional)" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={500} />
      </div>
    </Modal>
  );
}
