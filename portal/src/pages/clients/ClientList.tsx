import { useState } from "react";
import { Link } from "react-router";
import { useClients } from "../../lib/data";
import { displayNameOf, fmtDate } from "../../lib/format";
import { Avatar, Empty, ErrorNote, Loading, PageHeader } from "../../components/ui";

export default function ClientList() {
  const clients = useClients();
  const [search, setSearch] = useState("");
  const s = search.trim().toLowerCase();
  const shown = clients.data.filter((c) => !s || displayNameOf(c).toLowerCase().includes(s) || c.email?.toLowerCase().includes(s));

  return (
    <>
      <PageHeader title="Clients" subtitle="Everyone with a client account. New sign-ups appear here automatically." />
      <div className="filters">
        <input type="search" placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search clients" />
      </div>
      {clients.error && <ErrorNote>{clients.error}</ErrorNote>}
      {clients.loading ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Empty>{clients.data.length ? "No clients match." : "No clients yet. Share the sign-up link: /portal/signup"}</Empty>
      ) : (
        <ul className="people-list">
          {shown.map((c) => (
            <li key={c.id}>
              <Link to={`/clients/${c.id}`} className="person">
                <Avatar name={displayNameOf(c)} />
                <div className="person-main">
                  <div className="person-name">{displayNameOf(c)}</div>
                  <div className="muted small">{[c.email, c.phone].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="muted small">Joined {fmtDate(c.createdAt, { month: "short", year: "numeric" })}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
