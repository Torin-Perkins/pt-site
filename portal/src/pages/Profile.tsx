import { useEffect, useState, type FormEvent } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { sendPasswordResetEmail, updateProfile } from "firebase/auth";
import { auth, db } from "../firebase";
import { useSignedIn } from "../auth";
import { useLiveDoc } from "../lib/useFirestore";
import { Button, Card, PageHeader, TextArea, TextInput, useAction } from "../components/ui";
import { isStaffRole, type TrainerProfile } from "../types";

export default function Profile() {
  const { uid, profile, role, user } = useSignedIn();
  const [run, busy] = useAction();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [emergency, setEmergency] = useState("");
  const [goals, setGoals] = useState("");

  useEffect(() => {
    setName(profile?.displayName ?? "");
    setPhone(profile?.phone ?? "");
    setEmergency(profile?.emergencyContact ?? "");
    setGoals(profile?.goals ?? "");
  }, [profile?.displayName, profile?.phone, profile?.emergencyContact, profile?.goals]);

  async function save(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      await updateDoc(doc(db, "users", uid), { displayName: name.trim(), phone: phone.trim(), emergencyContact: emergency.trim(), goals: goals.trim() });
      if (name.trim() !== (user.displayName ?? "")) await updateProfile(user, { displayName: name.trim() });
    }, "Profile saved");
  }

  return (
    <>
      <PageHeader title="Profile" />
      <form onSubmit={save}>
        <Card title="About you">
          <div className="form-grid">
            <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            <TextInput label="Email" value={user.email ?? ""} disabled hint="Contact your coach to change your email." />
            <TextInput label="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} />
            <TextInput label="Emergency contact" value={emergency} onChange={(e) => setEmergency(e.target.value)} placeholder="Name & phone" />
            {role === "client" && (
              <TextArea label="Your goals" className="span-2" value={goals} onChange={(e) => setGoals(e.target.value)} maxLength={2000} placeholder="What would you like to be able to do?" />
            )}
          </div>
          <Button type="submit" busy={busy}>Save</Button>
        </Card>
      </form>
      {isStaffRole(role) && <CoachProfile uid={uid} />}
      <Card title="Password">
        <p className="muted">We'll email you a link to set a new password.</p>
        <Button variant="secondary" onClick={() => run(() => sendPasswordResetEmail(auth, user.email!), `Reset link sent to ${user.email}`)}>
          Send password reset email
        </Button>
      </Card>
    </>
  );
}

function CoachProfile({ uid }: { uid: string }) {
  const t = useLiveDoc<TrainerProfile>(`trainers/${uid}`);
  const [run, busy] = useAction();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [specialties, setSpecialties] = useState("");
  useEffect(() => {
    if (!t.data) return;
    setDisplayName(t.data.displayName ?? "");
    setBio(t.data.bio ?? "");
    setSpecialties((t.data.specialties ?? []).join(", "));
  }, [t.data]);

  return (
    <Card title="Coach profile" actions={<span className="muted small">Shown to clients when booking</span>}>
      <div className="stack">
        <TextInput label="Name clients see" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
        <TextArea label="Bio" rows={4} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={4000} />
        <TextInput label="Specialties" value={specialties} onChange={(e) => setSpecialties(e.target.value)} placeholder="Wedding prep, weight loss, bodybuilding" />
        <div>
          <Button
            busy={busy}
            onClick={() =>
              run(
                () => updateDoc(doc(db, "trainers", uid), { displayName: displayName.trim(), bio: bio.trim(), specialties: specialties.split(",").map((s) => s.trim()).filter(Boolean) }),
                "Coach profile saved",
              )
            }
          >
            Save coach profile
          </Button>
        </div>
      </div>
    </Card>
  );
}
