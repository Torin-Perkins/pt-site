import { call } from "../firebase";
import { fmtDate, money } from "../lib/format";
import type { Invoice } from "../types";
import { Badge, Button, Empty, useAction } from "./ui";

export function InvoiceTable({
  invoices,
  staff,
  clientName,
}: {
  invoices: Invoice[];
  staff?: boolean;
  clientName?: (id: string | null) => string;
}) {
  const [run, busy] = useAction();
  if (!invoices.length) return <Empty>No invoices yet.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            {clientName && <th>Client</th>}
            <th>Description</th>
            <th className="num">Amount</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id}>
              <td>{fmtDate(i.stripeCreated, { month: "short", day: "numeric", year: "numeric" })}</td>
              {clientName && <td>{clientName(i.clientId)}</td>}
              <td>
                {i.description || i.lines?.map((l) => l.description).filter(Boolean).join(", ") || i.number || "Invoice"}
                {i.status === "open" && i.dueDate && <div className="muted small">Due {fmtDate(i.dueDate)}</div>}
              </td>
              <td className="num">{money(i.status === "paid" ? i.amountPaid : i.amountDue, i.currency)}</td>
              <td><Badge status={i.status ?? "draft"} /></td>
              <td className="table-actions">
                {i.status === "open" && i.hostedInvoiceUrl && !staff && (
                  <a className="btn btn-primary btn-sm" href={i.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">Pay now</a>
                )}
                {i.hostedInvoiceUrl && (staff || i.status !== "open") && (
                  <a className="link small" href={i.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">{i.status === "paid" ? "Receipt" : "View"}</a>
                )}
                {staff && i.status === "open" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busy}
                    onClick={() => {
                      if (window.confirm("Void this invoice? The client will no longer be able to pay it.")) {
                        run(() => call("voidInvoice", { invoiceId: i.id }), "Invoice voided");
                      }
                    }}
                  >
                    Void
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
