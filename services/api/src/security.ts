import type { FastifyRequest } from "fastify";
import { auth, db } from "./firebase.js";
import { config } from "./config.js";

export async function requireEmployer(request: FastifyRequest): Promise<{ uid: string; companyId: string }> {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!bearer) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  const token = await auth.verifyIdToken(bearer).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    request.log.warn({ verificationError: detail }, "Firebase ID token verification failed");
    const message = config.NODE_ENV === "development"
      ? `Firebase token verification failed: ${detail}`
      : "Your session has expired. Please sign in again.";
    throw Object.assign(new Error(message), { statusCode: 401 });
  });
  const membership = await db.collection("memberships").doc(token.uid).get();
  const data = membership.data();
  if (!membership.exists || !data?.companyId || !["OWNER", "ADMIN"].includes(data.role)) throw Object.assign(new Error("Employer authorization required"), { statusCode: 403 });
  return { uid: token.uid, companyId: data.companyId as string };
}
