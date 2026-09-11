import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
const value = (name: string) => import.meta.env[name] || "development-not-configured";
// This allows the local UI shell to render without credentials; Firebase blocks sign-in until real config is supplied.
const firebase = initializeApp({ apiKey: value("VITE_FIREBASE_API_KEY"), authDomain: value("VITE_FIREBASE_AUTH_DOMAIN"), projectId: value("VITE_FIREBASE_PROJECT_ID") });
export const firebaseAuth = getAuth(firebase);
