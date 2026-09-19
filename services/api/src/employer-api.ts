import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, storage } from "./firebase.js";
import { requireEmployer } from "./security.js";
import { id, dateInput, schedule, timezone, ruleInput, defaultEmployerAlerts, defaultEmployeeAlerts, normaliseAlerts, employeeReportTypes, employerReportTypes, sanitiseAlertSettings } from "./schemas.js";
import { owned, clean, companyRecords, fail } from "./repository.js";
import { operationalData } from "./operational-data.js";
import { dayBounds, nextDate, localDate, milliseconds } from "@workstream/domain";

import {channelMetadata,channelType,removeChannel,saveChannel} from "./notification-channels.js";
const defaults={timezone:"UTC",requiredDailySeconds:28800,workdays:[1,2,3,4,5],idleThresholdSeconds:30,autoStopIdleSeconds:1800,monitoringMode:"SIMPLE_TIMER",lateStartDelaySeconds:3600};
export async function employerRoutes(app:FastifyInstance) {
  app.get("/v1/settings",async request=>{
    const a=await requireEmployer(request),company=await db.collection("companies").doc(a.companyId).get();
    const settings=await company.ref.collection("settings").get();
    return clean({company:{name:company.data()?.name,timezone:company.data()?.timezone},defaults:{...defaults,...settings.docs.find(d=>d.id==="defaults")?.data()},employerAlerts:normaliseAlerts(settings.docs.find(d=>d.id==="employerAlerts")?.data(),defaultEmployerAlerts,employerReportTypes),employeeAlerts:normaliseAlerts(settings.docs.find(d=>d.id==="employeeAlerts")?.data(),defaultEmployeeAlerts,employeeReportTypes),channels:await channelMetadata(a.companyId)});
  });
  app.get("/v1/notification-channels",async request=>clean(await channelMetadata((await requireEmployer(request)).companyId)));
  app.put("/v1/notification-channels/:type",async request=>{
    const a=await requireEmployer(request),type=channelType.parse((request.params as {type:string}).type),body=z.object({enabled:z.boolean(),destination:z.string().email().max(254).optional()}).parse(request.body);
    await saveChannel(a.companyId,type,body);await db.collection("audit_logs").add({companyId:a.companyId,actorUserId:a.uid,action:"NOTIFICATION_CHANNEL_SAVED",targetId:type,createdAt:Date.now()});return clean((await channelMetadata(a.companyId)).find(channel=>channel.type===type));
  });
  app.delete("/v1/notification-channels/:type",async request=>{const a=await requireEmployer(request),type=channelType.parse((request.params as {type:string}).type);await removeChannel(a.companyId,type);await db.collection("audit_logs").add({companyId:a.companyId,actorUserId:a.uid,action:"NOTIFICATION_CHANNEL_REMOVED",targetId:type,createdAt:Date.now()});return {removed:true};});
  app.patch("/v1/settings/:section",async request=>{
    const a=await requireEmployer(request),section=z.enum(["company","defaults","employerAlerts","employeeAlerts"]).parse((request.params as {section:string}).section);
    const value=section==="company"?z.object({name:z.string().trim().min(2).max(120),timezone}).parse(request.body):section==="defaults"?schedule.parse(request.body):sanitiseAlertSettings(request.body,section==="employeeAlerts"?"EMPLOYEE":"EMPLOYER");
    const company=db.collection("companies").doc(a.companyId),ref=section==="company"?company:company.collection("settings").doc(section);
    await db.runTransaction(async tx=>{const before=await tx.get(ref);const employees=section==="defaults"?await tx.get(db.collection("employees").where("companyId","==",a.companyId).where("status","==","ACTIVE")):null;let stored=value as Record<string,unknown>;if(section==="employerAlerts"||section==="employeeAlerts"){const supported=new Set<string>(section==="employeeAlerts"?employeeReportTypes:employerReportTypes),legacy=Object.fromEntries(Object.entries(before.data()??{}).filter(([type])=>!supported.has(type)).map(([type,rule])=>[type,{...(rule as Record<string,unknown>),enabled:false,activationVersion:3}]));stored={...legacy,...value};}tx.set(ref,stored,{merge:section==="company"});if(employees){const shared=value as {workdays:number[];idleThresholdSeconds:number;autoStopIdleSeconds:number;officeStart?:string;officeEnd?:string;lateStartDelaySeconds:number};for(const employee of employees.docs)tx.update(employee.ref,{workdays:shared.workdays,idleThresholdSeconds:shared.idleThresholdSeconds,autoStopIdleSeconds:shared.autoStopIdleSeconds,officeStart:shared.officeStart??null,officeEnd:shared.officeEnd??null,lateStartDelaySeconds:shared.lateStartDelaySeconds,updatedAt:Date.now()});}tx.create(db.collection("audit_logs").doc(),{companyId:a.companyId,actorUserId:a.uid,action:"SETTINGS_UPDATED",targetId:section,oldValue:clean(before.data()),newValue:stored,createdAt:Date.now()});});
    return {saved:true};
  });
  app.get("/v1/rules",async request=>{const a=await requireEmployer(request);return clean({rules:await companyRecords("monitoring_rules",a.companyId)});});
  app.post("/v1/rules",async request=>{
    const a=await requireEmployer(request),value=ruleInput.parse(request.body);if(value.employeeId)await owned("employees",value.employeeId,a.companyId);
    const ref=db.collection("monitoring_rules").doc();const batch=db.batch();
    batch.create(ref,{...value,companyId:a.companyId,scope:value.employeeId?"EMPLOYEE":"COMPANY",createdAt:Date.now()});
    batch.create(db.collection("audit_logs").doc(),{companyId:a.companyId,actorUserId:a.uid,action:"RULE_CREATED",targetId:ref.id,createdAt:Date.now()});await batch.commit();return {id:ref.id};
  });
  app.patch("/v1/rules/:id",async request=>{
    const a=await requireEmployer(request),key=id.parse((request.params as {id:string}).id),value=ruleInput.parse(request.body),record=await owned("monitoring_rules",key,a.companyId);
    if(value.employeeId)await owned("employees",value.employeeId,a.companyId);
    const batch=db.batch();batch.update(record.ref,{...value,scope:value.employeeId?"EMPLOYEE":"COMPANY",updatedAt:Date.now()});batch.create(db.collection("audit_logs").doc(),{companyId:a.companyId,actorUserId:a.uid,action:"RULE_UPDATED",targetId:key,createdAt:Date.now()});await batch.commit();return {saved:true};
  });
  app.delete("/v1/rules/:id",async request=>{const a=await requireEmployer(request),record=await owned("monitoring_rules",id.parse((request.params as {id:string}).id),a.companyId);const batch=db.batch();batch.delete(record.ref);batch.create(db.collection("audit_logs").doc(),{companyId:a.companyId,actorUserId:a.uid,action:"RULE_DELETED",targetId:record.id,createdAt:Date.now()});await batch.commit();return {deleted:true};});
  app.post("/v1/devices/:id/revoke",async request=>{
    const a=await requireEmployer(request),record=await owned("devices",id.parse((request.params as {id:string}).id),a.companyId);const batch=db.batch();
    batch.update(record.ref,{status:"REVOKED",revokedAt:Date.now()});batch.create(db.collection("audit_logs").doc(),{companyId:a.companyId,actorUserId:a.uid,action:"DEVICE_REVOKED",targetId:record.id,createdAt:Date.now()});await batch.commit();return {revoked:true};
  });
  app.get("/v1/reports",async request=>{
    const a=await requireEmployer(request),q=z.object({date:dateInput,period:z.enum(["daily","weekly"]).default("daily"),employeeId:id.optional()}).parse(request.query);
    const days=[];for(let i=0;i<(q.period==="weekly"?7:1);i++)days.push(await operationalData(a.companyId,nextDate(q.date,i)));
    const rows=days.flatMap(day=>day.employees.filter(e=>!q.employeeId||e.id===q.employeeId).map(e=>({...e,date:day.date})));
    const weekly=days[0].employees.filter(e=>!q.employeeId||e.id===q.employeeId).map(e=>{const own=rows.filter(r=>r.id===e.id),sum=(key:"timerSeconds"|"idleSeconds"|"effectiveSeconds"|"requiredSeconds")=>own.reduce((s,r)=>s+r[key],0),effectiveSeconds=sum("effectiveSeconds"),requiredSeconds=sum("requiredSeconds");return {...e,date:q.date+" – "+nextDate(q.date,6),timerSeconds:sum("timerSeconds"),idleSeconds:sum("idleSeconds"),effectiveSeconds,requiredSeconds,remainingSeconds:Math.max(0,requiredSeconds-effectiveSeconds),daysWorked:own.filter(r=>r.timerSeconds>0).length,targetStatus:effectiveSeconds>=requiredSeconds?"COMPLETED":"BELOW_TARGET"};});
    return clean({rows:q.period==="weekly"?weekly:rows,dailyRows:rows,period:q.period,date:q.date,timezone:days[0].company.timezone});
  });
  app.get("/v1/employees/:id/records",async request=>{
    const a=await requireEmployer(request),employeeId=id.parse((request.params as {id:string}).id),q=z.object({date:dateInput,page:z.coerce.number().int().min(1).default(1),kind:z.enum(["sessions","idle","activity","screenshots","devices","timeline"])}).parse(request.query);
    await owned("employees",employeeId,a.companyId);
    const company=(await db.collection("companies").doc(a.companyId).get()).data()!,bounds=dayBounds(q.date,company.timezone);
    const collections=q.kind==="timeline"?["work_sessions","idle_intervals","activity_events","screenshots","devices"]:[{sessions:"work_sessions",idle:"idle_intervals",activity:"activity_events",screenshots:"screenshots",devices:"devices"}[q.kind]];
    const rows=(await Promise.all(collections.map(async c=>(await companyRecords(c,a.companyId)).filter(r=>r.employeeId===employeeId).map(r=>({...r,kind:c}))))).flat().filter(r=>{if(q.kind==="devices")return r.status!=="REVOKED";const t=milliseconds(r.startedAt??r.timestamp??r.createdAt);return t<bounds.end&&(!r.stoppedAt&&!r.endedAt&&r.status==="ACTIVE"||milliseconds(r.stoppedAt??r.endedAt??t)>=bounds.start);}).sort((a,b)=>milliseconds(b.lastHeartbeatAt??b.startedAt??b.timestamp??b.createdAt)-milliseconds(a.lastHeartbeatAt??a.startedAt??a.timestamp??a.createdAt));
    const visible=q.kind==="devices"?rows.slice(0,1):rows;
    return clean({records:visible.slice((q.page-1)*25,q.page*25),total:visible.length});
  });
  app.get("/v1/screenshots/:id/image",async (request,reply)=>{
    const a=await requireEmployer(request),record=await owned("screenshots",id.parse((request.params as {id:string}).id),a.companyId);
    if(!record.data.storagePath?.startsWith(a.companyId+"/"))fail(404,"Screenshot unavailable.");
    if(record.data.uploadStatus!=="UPLOADED")fail(409,"Screenshot upload is still pending. It will appear when the employee agent finishes retrying.");
    return reply.type("image/jpeg").header("Cache-Control","private, max-age=60").send(storage.bucket().file(record.data.storagePath).createReadStream());
  });
}
