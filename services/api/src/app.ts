import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { employeeRoutes } from "./employees.js";
import { signupRoutes } from "./signup.js";
import { deviceRoutes } from "./device-api.js";
import { employerRoutes } from "./employer-api.js";
import { ZodError } from "zod";
import { screenshotRoutes } from "./screenshots.js";
import {jobsRoutes} from "./jobs.js";
import {correctionRoutes} from './corrections.js';

export async function buildApp(logger=false){
const app = Fastify({ logger });
const buckets=new Map<string,{count:number;until:number}>();
app.addHook("onRequest",async (request,reply)=>{
  const now=Date.now();
  if(buckets.size>10000)for(const [key,bucket] of buckets)if(bucket.until<now)buckets.delete(key);
  const sensitive=request.url.startsWith("/v1/signup")||request.url.startsWith("/v1/device/enroll"),key=request.ip+":"+sensitive;
  const bucket=buckets.get(key);if(bucket&&bucket.until>now){if(++bucket.count>(sensitive?12:300))return reply.code(429).header("Retry-After","60").send({message:"Too many requests. Please wait one minute."});}else if(buckets.size<20000)buckets.set(key,{count:1,until:now+60000});else return reply.code(503).send({message:"Server is busy. Please retry."});
});
const localOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
await app.register(cors, {
  origin: config.NODE_ENV === "development" ? localOrigins : config.APP_BASE_URL,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
});
app.get("/", async () => ({ service: "Workstream API", status: "ok", health: "/healthz" }));
app.get("/healthz", async () => ({ status: "ok" }));
await app.register(employeeRoutes);
await app.register(signupRoutes);
await app.register(deviceRoutes);
await app.register(employerRoutes);
await app.register(screenshotRoutes);
await app.register(jobsRoutes);
await app.register(correctionRoutes);
app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({message:"Check the highlighted fields.",fields:error.flatten().fieldErrors});
  const status=(error as {statusCode?:number}).statusCode??500;
  request.log.error({code:(error as {code?:string}).code,status},"Request failed");
  const deviceCode=(error as {deviceCode?:string}).deviceCode;
  const appCode=(error as {appCode?:string}).appCode;
  if(deviceCode)return reply.code(status).send({message:error instanceof Error?error.message:"Device access is no longer authorized.",code:deviceCode});
  return reply.code(status).send({message:status<500&&error instanceof Error?error.message:appCode&&error instanceof Error?error.message:"Unable to complete this request. Please try again.",...(appCode?{code:appCode}:{})});
});
return app;
}
