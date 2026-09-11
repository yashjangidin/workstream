import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./firebase.js";
import type { DocumentData } from "firebase-admin/firestore";
export interface StoredRecord extends DocumentData { id:string; status:string; startedAt?:number; endedAt?:number; stoppedAt?:number; createdAt?:number; timestamp?:number; sessionId:string; employeeId:string; deviceId:string; lastHeartbeatAt?:number; fullName:string; email:string; designation?:string; department?:string; employeeCode?:string; monitoringMode:string; workdays:number[]; requiredDailySeconds:number; officeStart?:string; officeEnd?:string; lateStartDelaySeconds?:number; }
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export const newCode = () => "WS-" + randomBytes(12).toString("hex").toUpperCase().match(/.{1,4}/g)!.join("-");
export const hashSecret = (plain: string) => { const salt = secret(); return salt + ":" + scryptSync(plain,salt,32).toString("base64url"); };
export const verifySecret = (plain: string, stored: string) => { const [salt,encoded] = stored.split(":"); if (!salt || !encoded) return false; const expected = Buffer.from(encoded,"base64url"); return expected.length === 32 && timingSafeEqual(scryptSync(plain,salt,32), expected); };
export function fail(statusCode: number, message: string): never { throw Object.assign(new Error(message), { statusCode }); }
export function clean(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && "toDate" in value) return (value as { toDate(): Date }).toDate().toISOString();
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !/hash|credential|encrypted|secret|token/i.test(k)).map(([k,v]) => [k,clean(v)]));
  return value;
}
export async function owned(collection: string, key: string, companyId: string) {
  const ref = db.collection(collection).doc(key), doc = await ref.get(), data = doc.data();
  if (!doc.exists || data?.companyId !== companyId || data?.status === "DELETED") fail(404,"Record not found.");
  return { ref, data: data!, id: doc.id };
}
export async function companyRecords(collection: string, companyId: string): Promise<StoredRecord[]> {
  const rows: StoredRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    let query = db.collection(collection).where("companyId","==",companyId).orderBy("__name__").limit(200);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get(); rows.push(...page.docs.map(d => ({ ...d.data(), id:d.id } as StoredRecord)));
    if (page.size < 200) break; cursor = page.docs.at(-1)!.id;
  }
  return rows;
}
export const audit = (companyId: string, actorUserId: string, action: string, targetId: string, metadata: unknown = {}) => db.collection("audit_logs").add({companyId,actorUserId,action,targetId,metadata:clean(metadata),createdAt:new Date()});
