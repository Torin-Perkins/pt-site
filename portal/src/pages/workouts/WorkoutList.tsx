import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useSignedIn } from "../../auth";
import { useWorkouts, WORKOUT_CATEGORIES } from "../../lib/data";
import { Badge, Empty, ErrorNote, Loading, PageHeader } from "../../components/ui";
import { isStaffRole } from "../../types";

export default function WorkoutList() {
  const { role } = useSignedIn();
  const staff = isStaffRole(role);
  const workouts = useWorkouts(staff);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<"" | "published" | "draft">("");

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return workouts.data.filter(
      (w) =>
        (!category || w.category === category) &&
        (!status || (status === "published") === w.published) &&
        (!s ||
          w.title.toLowerCase().includes(s) ||
          w.description?.toLowerCase().includes(s) ||
          w.exercises?.some((e) => e.name.toLowerCase().includes(s))),
    );
  }, [workouts.data, search, category, status]);

  return (
    <>
      <PageHeader
        title="Workouts"
        subtitle={staff ? "Your workout library. Clients see every published workout." : "Every workout from your coaches — pick one and log it."}
        actions={staff && <Link className="btn btn-primary" to="/workouts/new">New workout</Link>}
      />
      <div className="filters">
        <input type="search" placeholder="Search workouts or exercises" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search workouts" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {WORKOUT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        {staff && (
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
            <option value="">Published & drafts</option>
            <option value="published">Published</option>
            <option value="draft">Drafts</option>
          </select>
        )}
      </div>
      {workouts.error && <ErrorNote>{workouts.error}</ErrorNote>}
      {workouts.loading ? (
        <Loading />
      ) : shown.length === 0 ? (
        <Empty>{workouts.data.length ? "No workouts match." : staff ? "No workouts yet — create the first one." : "No workouts published yet."}</Empty>
      ) : (
        <div className="tile-grid">
          {shown.map((w) => (
            <Link key={w.id} to={`/workouts/${w.id}`} className="tile">
              <div className="tile-top">
                {w.category && <span className="eyebrow">{w.category}</span>}
                {staff && !w.published && <Badge status="draft">draft</Badge>}
              </div>
              <h3>{w.title}</h3>
              {w.description && <p className="tile-desc">{w.description}</p>}
              <p className="tile-meta">
                {[w.level, w.durationMin ? `${w.durationMin} min` : null, `${w.exercises?.length ?? 0} exercises`].filter(Boolean).join(" · ")}
              </p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
