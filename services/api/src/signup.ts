import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { auth, db } from "./firebase.js";
import { defaultEmployerAlerts, defaultEmployeeAlerts } from "./schemas.js";

export const signupInput = z.object({
  companyName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()).refine(value => !value.includes("/")),
  password: z.string().min(8).max(128),
  timezone: z.string().refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } })
});

export async function signupRoutes(app: FastifyInstance) {
  app.post("/v1/signup", async (request, reply) => {
    const parsed = signupInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Enter valid company and owner names, email, timezone, and a password of at least 8 characters." });
    const { companyName, ownerName, email, password, timezone } = parsed.data;
    let createdUid: string | undefined;
    let committed = false;
    try {
      const user = await auth.createUser({ email, password, displayName: ownerName });
      createdUid = user.uid;
      const company = db.collection("companies").doc(user.uid);
      await db.runTransaction(async tx => {
        const claim = db.collection("email_claims").doc(email);
        if ((await tx.get(claim)).exists) throw Object.assign(new Error("Duplicate email"), { code: "auth/email-already-exists" });
        const now = new Date();
        tx.create(claim, { userId: user.uid, companyId: company.id, createdAt: now });
        tx.create(company, { name: companyName, ownerName, ownerUserId: user.uid, timezone, status: "ACTIVE", createdAt: now, updatedAt: now });
        tx.create(db.collection("memberships").doc(user.uid), { companyId: company.id, role: "OWNER", createdAt: now });
        tx.create(company.collection("settings").doc("defaults"), { timezone, requiredDailySeconds: 28800, workdays: [1, 2, 3, 4, 5], idleThresholdSeconds: 30, autoStopIdleSeconds: 1800, lateStartDelaySeconds: 3600, monitoringMode: "SIMPLE_TIMER" });
        tx.create(company.collection("settings").doc("employerAlerts"), defaultEmployerAlerts);
        tx.create(company.collection("settings").doc("employeeAlerts"), defaultEmployeeAlerts);
        tx.create(db.collection("audit_logs").doc(), { companyId: company.id, actorUserId: user.uid, action: "COMPANY_CREATED", targetId: company.id, createdAt: now });
      });
      committed = true;
      return reply.code(201).send({ message: "Account created. You can now sign in." });
    } catch (error) {
      // Compensate only for the identity created by this request, never an existing account.
      if (createdUid && !committed) {
        try { await auth.deleteUser(createdUid); }
        catch { request.log.error({ uid: createdUid }, "Signup rollback needs administrator attention"); }
      }
      const code = (error as { code?: string }).code;
      if (code === "auth/email-already-exists") return reply.code(409).send({ message: "This email is already registered. Sign in or reset your password." });
      if (code === "auth/invalid-password" || code === "auth/password-does-not-meet-requirements") return reply.code(400).send({ message: "Choose a stronger password that meets the account password policy." });
      request.log.error({ err: error, code }, "Signup failed");
      return reply.code(503).send({ message: "We could not create your account. Please try again shortly." });
    }
  });
}
