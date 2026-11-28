import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useSignedIn } from "../auth";
import { usingEmulators } from "../firebase";
import { displayNameOf } from "../lib/format";
import { Avatar, Badge } from "./ui";
import type { Role } from "../types";

interface NavItem {
  to: string;
  label: string;
  roles: Role[];
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Home", roles: ["client", "trainer", "admin"], end: true },
  { to: "/workouts", label: "Workouts", roles: ["client", "trainer", "admin"] },
  { to: "/log", label: "My log", roles: ["client"] },
  { to: "/nutrition", label: "Nutrition", roles: ["client"] },
  { to: "/schedule", label: "Schedule", roles: ["client", "trainer", "admin"] },
  { to: "/clients", label: "Clients", roles: ["trainer", "admin"] },
  { to: "/billing", label: "Billing", roles: ["client", "trainer", "admin"] },
  { to: "/admin/users", label: "Team & roles", roles: ["admin"] },
  { to: "/profile", label: "Profile", roles: ["client", "trainer", "admin"] },
];

export default function Layout() {
  const { role, profile, user, signOut } = useSignedIn();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  const name = displayNameOf(profile ?? { email: user.email });
  return (
    <div className={`shell ${open ? "nav-open" : ""}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <button
          type="button"
          className="menu-btn"
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="sr-only">Menu</span>
          <span className="burger" aria-hidden="true" />
        </button>
        <a href="/" className="brand" aria-label="Toro Fitness home">
          <span className="toro-logo">TORO<span>FITNESS</span></span>
        </a>
        <span className="topbar-title">Client portal</span>
      </header>

      <aside className="sidebar" id="sidebar">
        <a href="/" className="brand brand-side" aria-label="Toro Fitness home">
          <span className="toro-logo">TORO<span>FITNESS</span></span>
        </a>
        <nav aria-label="Portal">
          <ul>
            {NAV.filter((n) => n.roles.includes(role)).map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.end} className={({ isActive }) => `nav-item ${isActive ? "is-active" : ""}`}>
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidebar-foot">
          <div className="me">
            <Avatar name={name} />
            <div>
              <div className="me-name">{name}</div>
              <Badge status={role}>{role}</Badge>
            </div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => signOut()}>
            Sign out
          </button>
          {usingEmulators && <p className="emulator-note">Local test mode (emulators)</p>}
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
