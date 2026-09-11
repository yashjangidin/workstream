import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { onAuthStateChanged, type User } from "firebase/auth";
import { AuthPage } from "./AuthPage";
import { FunctionalApp as EmployerApp } from "./FunctionalApp";
import { firebaseAuth } from "./firebase";
import "./styles.css";

function Root() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => onAuthStateChanged(firebaseAuth, value => { setUser(value); setReady(true); }), []);
  if (!ready) return <main className="auth-loading" role="status">Loading your workspace…</main>;
  return user ? <EmployerApp user={user}/> : <AuthPage/>;
}

createRoot(document.getElementById("root")!).render(<Root/>);
