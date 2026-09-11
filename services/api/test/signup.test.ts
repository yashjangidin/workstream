import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { auth, db } from "../src/firebase.js";
import { signupRoutes } from "../src/signup.js";

const payload = { companyName: "Example Company", ownerName: "Jane Owner", email: "Jane@Example.com", password: "test-password-123", timezone: "Asia/Calcutta" };

test("signup validates required fields before creating any identity", async () => {
  const app = Fastify(); await app.register(signupRoutes);
  const response = await app.inject({ method: "POST", url: "/v1/signup", payload: { ...payload, companyName: "", password: "short" } });
  assert.equal(response.statusCode, 400); await app.close();
});

test("signup creates the company, membership, defaults and email claim without signing in", async t => {
  const created: Array<{ path: string; value: Record<string, unknown> }> = [];
  const identity = t.mock.method(auth, "createUser", async (input: { email: string; displayName: string }) => {
    assert.equal(input.email, "jane@example.com"); assert.equal(input.displayName, "Jane Owner"); return { uid: "owner-123" };
  });
  t.mock.method(db, "runTransaction", async (run: (tx: unknown) => Promise<void>) => run({
    get: async () => ({ exists: false }),
    create: (ref: { path: string }, value: Record<string, unknown>) => created.push({ path: ref.path, value })
  }));
  const app = Fastify(); await app.register(signupRoutes);
  const response = await app.inject({ method: "POST", url: "/v1/signup", payload });
  assert.equal(response.statusCode, 201); assert.equal(identity.mock.callCount(), 1);
  assert.equal(created.length, 7);
  assert.equal(created.find(x => x.path === "memberships/owner-123")?.value.role, "OWNER");
  assert.equal(created.find(x => x.path === "companies/owner-123")?.value.name, payload.companyName);
  assert.ok(!JSON.stringify(created).includes(payload.password));
  assert.ok(!response.body.includes("token")); await app.close();
});

test("existing Firebase email is rejected and never deleted", async t => {
  t.mock.method(auth, "createUser", async () => { throw { code: "auth/email-already-exists" }; });
  const deleted = t.mock.method(auth, "deleteUser", async () => undefined);
  const app = Fastify(); await app.register(signupRoutes);
  const response = await app.inject({ method: "POST", url: "/v1/signup", payload });
  assert.equal(response.statusCode, 409); assert.equal(deleted.mock.callCount(), 0); await app.close();
});

test("an employee email claim rejects signup and compensates the new identity", async t => {
  t.mock.method(auth, "createUser", async () => ({ uid: "new-user" }));
  const deleted = t.mock.method(auth, "deleteUser", async () => undefined);
  t.mock.method(db, "runTransaction", async (run: (tx: unknown) => Promise<void>) => run({ get: async () => ({ exists: true }) }));
  const app = Fastify(); await app.register(signupRoutes);
  const response = await app.inject({ method: "POST", url: "/v1/signup", payload });
  assert.equal(response.statusCode, 409); assert.deepEqual(deleted.mock.calls[0].arguments, ["new-user"]); await app.close();
});

test("database failure removes only the newly created identity and returns a safe error", async t => {
  t.mock.method(auth, "createUser", async () => ({ uid: "new-user" }));
  const deleted = t.mock.method(auth, "deleteUser", async () => undefined);
  t.mock.method(db, "runTransaction", async () => { throw new Error("private backend details"); });
  const app = Fastify(); await app.register(signupRoutes);
  const response = await app.inject({ method: "POST", url: "/v1/signup", payload });
  assert.equal(response.statusCode, 503); assert.deepEqual(deleted.mock.calls[0].arguments, ["new-user"]);
  assert.ok(!response.body.includes("private backend details")); await app.close();
});
