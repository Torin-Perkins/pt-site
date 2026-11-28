import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "./auth";
import { isConfigured } from "./firebase";
import { isStaffRole, type Role } from "./types";
import Layout from "./components/Layout";
import { Loading } from "./components/ui";
import { SignIn, SignUp, ResetPassword } from "./pages/AuthPages";
import Home from "./pages/Home";
import WorkoutList from "./pages/workouts/WorkoutList";
import WorkoutDetail from "./pages/workouts/WorkoutDetail";
import WorkoutEditor from "./pages/workouts/WorkoutEditor";
import LogPage from "./pages/log/LogPage";
import WorkoutLogForm from "./pages/log/WorkoutLogForm";
import MyNutrition from "./pages/nutrition/MyNutrition";
import ClientSchedule from "./pages/schedule/ClientSchedule";
import TrainerSchedule from "./pages/schedule/TrainerSchedule";
import AvailabilityEditor from "./pages/schedule/AvailabilityEditor";
import ClientList from "./pages/clients/ClientList";
import ClientDetail from "./pages/clients/ClientDetail";
import LiveWorkoutLog from "./pages/clients/LiveWorkoutLog";
import ClientBilling from "./pages/billing/ClientBilling";
import StaffBilling from "./pages/billing/StaffBilling";
import Users from "./pages/admin/Users";
import Profile from "./pages/Profile";

function NotConfigured() {
  return (
    <div className="auth-page">
      <div className="auth-card">
        {/* Shown until the Firebase web config is filled in (portal/.env.production). */}
        <a href="/" className="auth-logo" aria-label="Toro Fitness home"><span className="toro-logo">TORO<span>FITNESS</span></span></a>
        <h1>Client portal coming soon</h1>
        <p>Your workouts, nutrition plan, check-ins and sessions will live here. Check back shortly.</p>
        <p><a href="/">Back to the Toro Fitness site</a></p>
      </div>
    </div>
  );
}

/** Renders children only for signed-in people (optionally only some roles). */
function Protected({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user, role, ready } = useAuth();
  const location = useLocation();
  if (user === undefined || !ready) return <div className="center-page"><Loading /></div>;
  if (!user) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  if (!role) {
    return (
      <div className="center-page">
        <Loading label="Setting up your account…" />
      </div>
    );
  }
  if (roles && !roles.includes(role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function ByRole({ client, staff }: { client: ReactNode; staff: ReactNode }) {
  const { role } = useAuth();
  return <>{isStaffRole(role) ? staff : client}</>;
}

const STAFF: Role[] = ["trainer", "admin"];

// Adding a new top-level page? Also add it to the portal routes in render.yaml.
export default function App() {
  if (!isConfigured) return <NotConfigured />;
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route path="/signup" element={<SignUp />} />
      <Route path="/reset" element={<ResetPassword />} />
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<Home />} />
        <Route path="workouts" element={<WorkoutList />} />
        <Route path="workouts/new" element={<Protected roles={STAFF}><WorkoutEditor /></Protected>} />
        <Route path="workouts/:id" element={<WorkoutDetail />} />
        <Route path="workouts/:id/edit" element={<Protected roles={STAFF}><WorkoutEditor /></Protected>} />
        <Route path="log" element={<Protected roles={["client"]}><LogPage /></Protected>} />
        <Route path="log/workout" element={<Protected roles={["client"]}><WorkoutLogForm /></Protected>} />
        <Route path="nutrition" element={<Protected roles={["client"]}><MyNutrition /></Protected>} />
        <Route path="schedule" element={<ByRole client={<ClientSchedule />} staff={<TrainerSchedule />} />} />
        <Route path="schedule/availability" element={<Protected roles={STAFF}><AvailabilityEditor /></Protected>} />
        <Route path="clients" element={<Protected roles={STAFF}><ClientList /></Protected>} />
        <Route path="clients/:id" element={<Protected roles={STAFF}><ClientDetail /></Protected>} />
        <Route path="clients/:clientId/log" element={<Protected roles={STAFF}><LiveWorkoutLog /></Protected>} />
        <Route path="clients/:clientId/log/:logId" element={<Protected roles={STAFF}><LiveWorkoutLog /></Protected>} />
        <Route path="billing" element={<ByRole client={<ClientBilling />} staff={<StaffBilling />} />} />
        <Route path="admin/users" element={<Protected roles={["admin"]}><Users /></Protected>} />
        <Route path="profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
