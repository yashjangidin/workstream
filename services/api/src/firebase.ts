import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { readFileSync } from "node:fs";
import { config } from "./config.js";

const encoded = process.env.FIREBASE_ADMIN_CONFIG;
const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
// A local service-account file is the expected development setup. Loading it
// explicitly prevents a stale machine-wide Google credential from being used.
const credential = encoded
  ? cert(JSON.parse(encoded))
  : credentialPath
    ? cert(JSON.parse(readFileSync(credentialPath, "utf8")))
    : applicationDefault();
const app = getApps()[0] ?? initializeApp({ credential, projectId: config.FIREBASE_PROJECT_ID, storageBucket: config.FIREBASE_STORAGE_BUCKET });
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
