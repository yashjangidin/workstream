import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function loadProjectEnvironment() {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(sourceDirectory, "../../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env")
  ];
  const file = candidates.find(existsSync);
  if (!file) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}

loadProjectEnvironment();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"), PORT: z.coerce.number().int().positive().default(8080),
  APP_BASE_URL: z.string().url().default("http://localhost:5173"), FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_STORAGE_BUCKET: z.string().optional(), AGENT_DOWNLOAD_URL: z.string().url().optional(),
  HEARTBEAT_INTERVAL: z.coerce.number().int().positive().default(60), OFFLINE_TIMEOUT: z.coerce.number().int().positive().default(180),
  SCREENSHOT_INTERVAL: z.coerce.number().int().positive().default(30)
}).superRefine((value, ctx) => { if (value.NODE_ENV === "production" && !value.FIREBASE_PROJECT_ID) ctx.addIssue({ code: "custom", message: "FIREBASE_PROJECT_ID is required in production" }); });
export const config = schema.parse(process.env);
