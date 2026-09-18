import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

test("base API endpoint and health check provide a usable service response", async () => {
  const app = await buildApp();
  const root = await app.inject({ method: "GET", url: "/" });
  const health = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(root.statusCode, 200);
  assert.deepEqual(root.json(), { service: "Workstream API", status: "ok", health: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok" });
  await app.close();
});

test("browser preflight permits notification channel updates", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "OPTIONS",
    url: "/v1/notification-channels/DASHBOARD",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "authorization,content-type"
    }
  });
  assert.equal(response.statusCode, 204);
  assert.match(response.headers["access-control-allow-methods"] ?? "", /\bPUT\b/);
  await app.close();
});
