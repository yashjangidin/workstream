import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "./firebase.js";
import { digest, secret, verifySecret, fail } from "./repository.js";
import { id, ruleInput } from "./schemas.js";
import { config } from "./config.js";
import { classify, calculateTimeTotals, type Rule } from "@workstream/domain";
import { companyRecords } from "./repository.js";
import { addDashboardTime, patchDashboardEmployee } from "./dashboard-summary.js";

function deviceFailure(code:"DEVICE_REVOKED"|"CREDENTIAL_INVALID"|"EMPLOYEE_DELETED"|"EMPLOYEE_DEACTIVATED",message:string): never {
  throw Object.assign(new Error(message),{statusCode:401,deviceCode:code});
}

export async function requireDevice(request: FastifyRequest) {
  const raw = request.headers.authorization?.match(/^Device ([\w-]+)\.([\w-]+)$/);
  if (!raw) fail(401,"Device authentication required.");
  const ref=db.collection("devices").doc(raw![1]), doc=await ref.get(), data=doc.data();
  if(!data) deviceFailure("CREDENTIAL_INVALID","This device credential is no longer valid.");
  const activeDevice=data;
  const employeeRef=db.collection("employees").doc(activeDevice.employeeId), employee=(await employeeRef.get()).data();
  if(!employee||employee.status==="DELETED") deviceFailure("EMPLOYEE_DELETED","This employee profile has been deleted.");
  if(employee.status!=="ACTIVE"||employee.companyId!==activeDevice.companyId) deviceFailure("EMPLOYEE_DEACTIVATED","This employee profile is no longer active.");
  if(activeDevice.status==="REVOKED") deviceFailure("DEVICE_REVOKED","This device has been revoked.");
  if(activeDevice.credentialHash!==digest(raw![2])) deviceFailure("CREDENTIAL_INVALID","This device credential is no longer valid.");
  return {ref,data:activeDevice,employeeRef,employee,deviceId:doc.id,employeeId:activeDevice.employeeId as string,companyId:activeDevice.companyId as string};
}
const eventInput=z.object({operationId:id,sessionId:id,at:z.number().int().positive().refine(v=>v<=Date.now()+60000,"Timestamp is in the future.")});
export async function deviceRoutes(app:FastifyInstance) {
  app.delete("/v1/device/self",async request=>{
    const d=await requireDevice(request);
    await db.runTransaction(async tx=>{
      const employee=await tx.get(d.employeeRef);
      if(employee.data()?.activeSessionId) fail(409,"Stop the timer before removing Workstream.");
      tx.delete(d.ref);
    });
    return {removed:true};
  });
  app.post("/v1/device/enroll",async request=>{
    const body=z.object({setupCode:z.string().min(8).max(100),installationId:id,credential:z.string().min(40).max(100),name:z.string().min(1).max(120),agentVersion:z.string().max(30)}).parse(request.body);
    const key=digest(body.setupCode.trim().toUpperCase()), lookup=db.collection("setup_codes").doc(key);
    return db.runTransaction(async tx=>{
      const link=(await tx.get(lookup)).data();
      if(!link) fail(401,"Invalid setup code. Ask your employer to regenerate it.");
      const employeeRef=db.collection("employees").doc(link.employeeId), employee=(await tx.get(employeeRef)).data();
      if(!employee||employee.status!=="ACTIVE"||employee.setupCodeKey!==key||!verifySecret(body.setupCode.trim().toUpperCase(),employee.setupCodeHash)) fail(401,"Invalid or revoked setup code.");
      const deviceId=digest(link.employeeId+":"+body.installationId), ref=db.collection("devices").doc(deviceId), existing=(await tx.get(ref)).data();
      if(existing?.status==="REVOKED") fail(403,"This installation has been revoked.");
      if(existing && existing.credentialHash!==digest(body.credential)) fail(409,"Installation already paired with another credential.");
      if(!existing) tx.create(ref,{companyId:employee.companyId,employeeId:link.employeeId,name:body.name,platform:"Windows",agentVersion:body.agentVersion,credentialHash:digest(body.credential),status:"ACTIVE",createdAt:Date.now(),lastHeartbeatAt:Date.now(),lastSyncAt:Date.now()});
      return {deviceId,employeeId:link.employeeId,employeeName:employee.fullName,configuration:{...employee,setupCodeHash:undefined,setupCodeKey:undefined},heartbeatSeconds:config.HEARTBEAT_INTERVAL};
    });
  });
  app.get("/v1/device/config",async request=>{
    const d=await requireDevice(request);
    return {employeeName:d.employee.fullName,timezone:d.employee.timezone,requiredDailySeconds:d.employee.requiredDailySeconds,idleThresholdSeconds:d.employee.idleThresholdSeconds,monitoringMode:"SIMPLE_TIMER",heartbeatSeconds:config.HEARTBEAT_INTERVAL,screenshotSeconds:0};
  });
  app.post("/v1/device/heartbeat",async request=>{
    const d=await requireDevice(request);
    const body=z.object({agentVersion:z.string().max(30),timerState:z.enum(["RUNNING","STOPPED"]),sessionId:id.nullable().optional(),timerStateAt:z.number().int().positive().refine(v=>v<=Date.now()+60000,"Timestamp is in the future.").optional()}).parse(request.body);
    const stopped=await db.runTransaction(async tx=>{
      const [doc,employee]=await Promise.all([tx.get(d.ref),tx.get(d.employeeRef)]);
      if(doc.data()?.status==="REVOKED")deviceFailure("DEVICE_REVOKED","This device has been revoked.");
      const now=Date.now();
      const activeSessionId=employee.data()?.activeSessionId;
      let sessionRef:any, session:any, idle:any;
      const sessionMismatch=body.timerState==="RUNNING"&&Boolean(body.sessionId)&&activeSessionId!==body.sessionId;
      if(activeSessionId&&(body.timerState==="STOPPED"||sessionMismatch)){
        sessionRef=db.collection("work_sessions").doc(activeSessionId);
        [session,idle]=await Promise.all([tx.get(sessionRef),tx.get(db.collection("idle_intervals").where("sessionId","==",activeSessionId))]);
      }
      // All transaction reads are complete above. Firestore forbids reads after
      // the first write in a transaction.
      tx.update(d.ref,{lastHeartbeatAt:now,lastSyncAt:now,agentVersion:body.agentVersion,timerState:body.timerState});
      const s=session?.data();
      if(!s||s.status!=="ACTIVE"||s.deviceId!==d.deviceId)return null;
      const stoppedAt=Math.max(Number(s.startedAt),Math.min(now,body.timerStateAt??now));
      const intervals=idle.docs.map((interval:any)=>{const value=interval.data();return {startedAt:new Date(value.startedAt),endedAt:new Date(value.endedAt??stoppedAt)};});
      const totals=calculateTimeTotals({startedAt:new Date(s.startedAt),endedAt:new Date(stoppedAt)},intervals);
      idle.docs.filter((interval:any)=>!interval.data().endedAt).forEach((interval:any)=>tx.update(interval.ref,{endedAt:stoppedAt}));
      tx.update(sessionRef,{stoppedAt,status:"COMPLETED",...totals,updatedAt:now,closedBy:body.timerState==="STOPPED"?"STOPPED_HEARTBEAT":"SESSION_RECONCILIATION"});
      tx.update(d.employeeRef,{activeSessionId:null});
      return totals;
    });
    await patchDashboardEmployee(d.companyId,d.employeeId,{deviceStatus:"ONLINE",timerStatus:body.timerState,workStatus:body.timerState==="RUNNING"?"WORKING":"NOT_WORKING",device:{id:d.deviceId,name:d.data.name,platform:d.data.platform,status:"ACTIVE",lastHeartbeatAt:Date.now(),timerState:body.timerState,agentVersion:body.agentVersion}});
    if(stopped) await addDashboardTime(d.companyId,d.employeeId,stopped);
    return {received:true};
  });
  app.post("/v1/device/sessions/start",async request=>{
    const d=await requireDevice(request), body=eventInput.parse(request.body), ref=db.collection("work_sessions").doc(body.sessionId);
    const result=await db.runTransaction(async tx=>{
      const [old,employee,device]=await Promise.all([tx.get(ref),tx.get(d.employeeRef),tx.get(d.ref)]);
      if(employee.data()?.status==="DELETED")deviceFailure("EMPLOYEE_DELETED","This employee profile has been deleted.");
      if(employee.data()?.status!=="ACTIVE")deviceFailure("EMPLOYEE_DEACTIVATED","This employee profile is no longer active.");
      if(device.data()?.status==="REVOKED")deviceFailure("DEVICE_REVOKED","This device has been revoked.");
      if(old.exists){if(old.data()?.deviceId!==d.deviceId)fail(409,"Session ID unavailable.");return {sessionId:body.sessionId};}
      if(employee.data()?.activeSessionId)fail(409,"An active session already exists.");
      tx.create(ref,{id:body.sessionId,companyId:d.companyId,employeeId:d.employeeId,deviceId:d.deviceId,startedAt:body.at,stoppedAt:null,status:"ACTIVE",createdAt:Date.now()});
      tx.update(d.employeeRef,{activeSessionId:body.sessionId});tx.update(d.ref,{timerState:"RUNNING"});
      return {sessionId:body.sessionId};
    });
    await patchDashboardEmployee(d.companyId,d.employeeId,{deviceStatus:"ONLINE",timerStatus:"RUNNING",workStatus:"WORKING",activeSessionStartedAt:body.at,activeSessionSnapshotAt:Date.now(),activeIdleStartedAt:null,liveIdleIntervals:{},device:{id:d.deviceId,name:d.data.name,platform:d.data.platform,status:"ACTIVE",lastHeartbeatAt:Date.now(),timerState:"RUNNING",agentVersion:d.data.agentVersion}});
    return result;
  });
  app.post("/v1/device/idle",async request=>{
    const d=await requireDevice(request), body=eventInput.extend({idleId:id,endedAt:z.number().int().positive().nullable()}).parse(request.body);
    const ref=db.collection("idle_intervals").doc(body.idleId), sessionRef=db.collection("work_sessions").doc(body.sessionId);
    const saved=await db.runTransaction(async tx=>{
      const [session,device,existing]=await Promise.all([tx.get(sessionRef),tx.get(d.ref),tx.get(ref)]);const s=session.data();
      if(device.data()?.status==="REVOKED")deviceFailure("DEVICE_REVOKED","This device has been revoked.");
      if(!s||s.deviceId!==d.deviceId)fail(404,"Session not found.");
      if(body.at<s.startedAt||(body.endedAt!==null&&(body.endedAt<body.at||body.endedAt>Date.now()+60000)))fail(400,"Invalid idle interval.");
      // A stale open-idle marker may arrive after the heartbeat has safely
      // closed the session. The later closing marker contains the full interval.
      if(s.stoppedAt&&body.endedAt===null)return false;
      if(s.stoppedAt&&body.at>s.stoppedAt)return false;
      if(existing.exists&&existing.data()?.sessionId!==body.sessionId)fail(409,"Idle ID unavailable.");
      // Device requests are queued and retried. Only the first transition for
      // an interval changes the compact dashboard projection.
      if(existing.data()?.endedAt)return false;
      if(existing.exists&&body.endedAt===null)return false;
      const endedAt=s.stoppedAt&&body.endedAt?Math.min(body.endedAt,s.stoppedAt):body.endedAt;
      tx.set(ref,{companyId:d.companyId,employeeId:d.employeeId,deviceId:d.deviceId,sessionId:body.sessionId,startedAt:body.at,endedAt});
      return true;
    });
    if(saved)await patchDashboardEmployee(d.companyId,d.employeeId,{workStatus:body.endedAt===null?"IDLE":"WORKING",activeIdleStartedAt:body.endedAt===null?body.at:null,liveIdleIntervals:{[body.idleId]:{startedAt:body.at,endedAt:body.endedAt}}});
    return {saved:true};
  });
  app.post("/v1/device/sessions/stop",async request=>{
    const d=await requireDevice(request), body=eventInput.parse(request.body), ref=db.collection("work_sessions").doc(body.sessionId);
    const result=await db.runTransaction(async tx=>{
      const [session,device,idle]=await Promise.all([tx.get(ref),tx.get(d.ref),tx.get(db.collection("idle_intervals").where("sessionId","==",body.sessionId))]);const s=session.data();
      if(device.data()?.status==="REVOKED")deviceFailure("DEVICE_REVOKED","This device has been revoked.");
      if(!s||s.deviceId!==d.deviceId)fail(404,"Session not found.");
      if(s.status!=="ACTIVE")return {sessionId:body.sessionId};
      if(body.at<s.startedAt)fail(400,"Stop precedes start.");
      const intervals=idle.docs.map(doc=>{const i=doc.data();if(!i.endedAt)tx.update(doc.ref,{endedAt:body.at});return {startedAt:new Date(i.startedAt),endedAt:new Date(i.endedAt??body.at)};});
      const totals=calculateTimeTotals({startedAt:new Date(s.startedAt),endedAt:new Date(body.at)},intervals);
      tx.update(ref,{stoppedAt:body.at,status:"COMPLETED",...totals,updatedAt:Date.now()});tx.update(d.employeeRef,{activeSessionId:null});tx.update(d.ref,{timerState:"STOPPED"});
      return {sessionId:body.sessionId,...totals};
    });
    if("timerSeconds" in result) await addDashboardTime(d.companyId,d.employeeId,result as {timerSeconds:number;idleSeconds:number;effectiveSeconds:number});
    return result;
  });
  app.post("/v1/device/activity",async request=>{
    const d=await requireDevice(request),body=eventInput.extend({endedAt:z.number().int().positive(),application:z.string().max(128),domain:z.string().max(255).optional()}).parse(request.body);
    const rules=await companyRecords("monitoring_rules",d.companyId);
    const classification=classify(rules.map(r=>({...ruleInput.parse(r),scope:r.scope})),d.employeeId,body.application,body.domain);
    await db.runTransaction(async tx=>{
      const [employee,device,session,existing]=await Promise.all([tx.get(d.employeeRef),tx.get(d.ref),tx.get(db.collection("work_sessions").doc(body.sessionId)),tx.get(db.collection("activity_events").doc(body.operationId))]);
      const s=session.data();
      if(device.data()?.status==="REVOKED")deviceFailure("DEVICE_REVOKED","This device has been revoked.");
      if(employee.data()?.monitoringMode!=="ACTIVE_MONITORING")fail(409,"Activity monitoring is disabled.");
      if(!s||s.deviceId!==d.deviceId)fail(404,"Session not found.");
      if(body.at<s.startedAt||body.endedAt<body.at||body.endedAt>Date.now()+60000||(s.stoppedAt&&body.endedAt>s.stoppedAt))fail(400,"Activity is outside session.");
      if(existing.exists){if(existing.data()?.deviceId!==d.deviceId)fail(409,"Event ID unavailable.");return;}
      tx.create(db.collection("activity_events").doc(body.operationId),{companyId:d.companyId,employeeId:d.employeeId,deviceId:d.deviceId,sessionId:body.sessionId,startedAt:body.at,endedAt:body.endedAt,application:body.application,domain:body.domain??null,classification,createdAt:Date.now()});
    });return {saved:true};
  });
}
