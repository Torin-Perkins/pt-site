import { useState } from "react";
import { collection, query } from "firebase/firestore";
import { call, db } from "../../firebase";
import { useSignedIn } from "../../auth";
import { useLiveQuery } from "../../lib/useFirestore";
import { displayNameOf } from "../../lib/format";
import { Avatar, Badge, Card, ErrorNote, Loading, PageHeader, useAction } from "../../components/ui";
import type { Role, UserProfile } from "../../types";

const ORDER: Record<string, number> = { admin: 0, trainer: 1, client: 2 };

export default function Users() {
  const { uid } = useSignedIn();
  const users = useLiveQuery<UserProfile>(() => query(collection(db, "users")), []);
  const [search, setSearch] = useState("");
  const [run, busy] = useAction();
  const s = search.trim().toLowerCase();
  const shown = users.data
    .filter((u) => !u.deleted && (!s || displayNameOf(u).toLowerCase().includes(s) || u.email?.toLowerCase().includes(s)))
    .sort((a, b) => (ORDER[a.role ?? "client"] ?? 3) - (ORDER[b.role ?? "client"] ?? 3) || displayNameOf(a).localeCompare(displayNameOf(b)));

  async function change(u: UserProfile, role: Role) {
    if (role === u.role) return;
    const msg =
      role === "client"
        ? `Make ${displayNameOf(u)} a client? They'll lose access to client data.`
        : `Give ${displayNameOf(u)} the ${role} role? ${role === "admin" ? "Admins can change anyone's role and manage billing." : "Trainers can see and edit every client's information."}`;
    if (!window.confirm(msg)) return;
    await run(() => call("setUserRole", { uid: u.id, role }), `${displayNameOf(u)} is now ${role === "admin" ? "an admin" : `a ${role}`}`);
  }

  return (
    <>
      <PageHeader title="Team & roles" subtitle="Everyone signs up as a client. Promote coaches here — they get access the next time their page refreshes." />
      <div className="filters">
        <input type="search" placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search people" />
      </div>
      {users.error && <ErrorNote>{users.error}</ErrorNote>}
      <Card>
        {users.loading ? (
          <Loading />
        ) : (
          <ul className="people-list">
            {shown.map((u) => (
              <li key={u.id} className="person">
                <Avatar name={displayNameOf(u)} />
                <div className="person-main">
                  <div className="person-name">{displayNameOf(u)} {u.id === uid && <span className="muted small">(you)</span>}</div>
                  <div className="muted small">{u.email}</div>
                </div>
                {u.id === uid ? (
                  <Badge status={u.role ?? "client"}>{u.role}</Badge>
                ) : (
                  <select aria-label={`Role for ${displayNameOf(u)}`} value={u.role ?? "client"} disabled={busy} onChange={(e) => change(u, e.target.value as Role)}>
                    <option value="client">Client</option>
                    <option value="trainer">Trainer</option>
                    <option value="admin">Admin</option>
                  </select>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
