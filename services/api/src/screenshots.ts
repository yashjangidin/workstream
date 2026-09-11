import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db,storage } from "./firebase.js";
import { requireDevice } from "./device-api.js";
import { id,ruleInput } from "./schemas.js";
import { digest,companyRecords,fail } from "./repository.js";
import { classify } from "@workstream/domain";
export async function screenshotRoutes(app:FastifyInstance){
  app.post("/v1/device/screenshots",{bodyLimit:6000000},async request=>{
    const d=await requireDevice(request);
    const b=z.object({operationId:id,sessionId:id,at:z.number().int().positive(),application:z.string().max(128),domain:z.string().max(255).optional(),jpeg:z.string().max(5500000)}).parse(request.body);
    const bytes=Buffer.from(b.jpeg,"base64");
    if(bytes.length>4000000||bytes[0]!==255||bytes[1]!==216)fail(400,"Invalid JPEG image.");
    // Screenshot storage is intentionally disabled until a bucket is provisioned.
    // Accept and discard uploads so older agents cannot block timer/session sync
    // while repeatedly retrying an unavailable paid Storage service.
    if (process.env.SCREENSHOT_UPLOADS_ENABLED !== "true") return { uploaded: false, skipped: true };
    const ref=db.collection("screenshots").doc(b.operationId),path=d.companyId+"/"+d.employeeId+"/"+b.operationId+".jpg",contentHash=digest(b.jpeg);
    const rules=(await companyRecords("monitoring_rules",d.companyId)).map(r=>({...ruleInput.parse(r),scope:r.scope}));
    const classification=classify(rules,d.employeeId,b.application,b.domain);
    const done=await db.runTransaction(async tx=>{
      const [device,employee,session,existing]=await Promise.all([tx.get(d.ref),tx.get(d.employeeRef),tx.get(db.collection("work_sessions").doc(b.sessionId)),tx.get(ref)]);
      if(device.data()?.status==="REVOKED")fail(401,"Device revoked.");
      if(employee.data()?.monitoringMode!=="ACTIVE_MONITORING")fail(409,"Screenshot monitoring is disabled.");
      const s=session.data();
      if(!s||s.deviceId!==d.deviceId)fail(404,"Session not found.");
      if(b.at<s.startedAt||b.at>Date.now()+60000||(s.stoppedAt&&b.at>s.stoppedAt))fail(400,"Screenshot is outside the session.");
      if(existing.exists){if(existing.data()?.deviceId!==d.deviceId||existing.data()?.contentHash!==contentHash)fail(409,"Screenshot ID conflict.");return existing.data()?.uploadStatus==="UPLOADED";}
      tx.create(ref,{companyId:d.companyId,employeeId:d.employeeId,deviceId:d.deviceId,sessionId:b.sessionId,timestamp:b.at,application:b.application,domain:b.domain??null,classification,classificationSource:"RULE",storagePath:path,contentHash,uploadStatus:"PENDING",createdAt:Date.now()});return false;
    });
    if(!done){
      try{
        await storage.bucket().file(path).save(bytes,{resumable:false,metadata:{contentType:"image/jpeg",cacheControl:"private,max-age=60"}});
        await ref.update({uploadStatus:"UPLOADED",uploadedAt:Date.now()});
      }catch{
        throw Object.assign(new Error("Screenshot storage is unavailable. Upload will retry automatically."),{statusCode:503,appCode:"SCREENSHOT_STORAGE_UNAVAILABLE"});
      }
    }
    return {uploaded:true};
  });
}
