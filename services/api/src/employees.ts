import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "./firebase.js";
import { requireEmployer } from "./security.js";
import { employeeInput, id, dateInput } from "./schemas.js";
import { newCode, digest, hashSecret, clean, owned, audit, fail } from "./repository.js";
import { operationalData } from "./operational-data.js";
import {encrypt,decrypt,notificationRecord,deliver} from "./notifications.js";
import { createReadStream } from "node:fs";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
const installerPath=()=>{
  if(process.env.WORKSTREAM_INSTALLER_PATH)return process.env.WORKSTREAM_INSTALLER_PATH;
  const candidates=[path.resolve(process.cwd(),"artifacts","installer","WorkstreamSetup.exe"),path.resolve(process.cwd(),"..","..","artifacts","installer","WorkstreamSetup.exe"),path.resolve(process.cwd(),"artifacts","WorkstreamSetup.exe")];
  return candidates.find(candidate=>existsSync(candidate))??candidates[0];
};
const installerUrl=()=>process.env.AGENT_DOWNLOAD_URL||`${process.env.PUBLIC_API_BASE_URL||`http://127.0.0.1:${config.PORT}`}/downloads/WorkstreamSetup.exe`;
const installerAvailable=()=>Boolean(process.env.AGENT_DOWNLOAD_URL)||(existsSync(installerPath())&&statSync(installerPath()).isFile());
const inviteText=(name:string,code:string)=>`Welcome to Workstream, ${name}.\n\nDownload WorkstreamSetup.exe:\n${installerAvailable()?installerUrl():"WorkstreamSetup.exe is currently unavailable. Ask your employer to retry after the installer is published."}\n\nSetup code:\n${code}\n\nSteps:\n1. Download and install Workstream.\n2. Launch the application.\n3. Enter the setup code.\n4. Wait until the application shows Connected.`;
export { verifySecret } from "./repository.js";

export async function employeeRoutes(app: FastifyInstance) {
  app.get("/downloads/WorkstreamSetup.exe/status", async () => ({ available: installerAvailable(), url: installerUrl() }));
  app.get("/downloads/WorkstreamSetup.exe",async (_request,reply)=>{
    // In hosted environments the installer lives on the configured release/CDN.
    // Redirect the browser there instead of looking for a build artifact inside
    // the API container.
    if(process.env.AGENT_DOWNLOAD_URL)return reply.redirect(process.env.AGENT_DOWNLOAD_URL);
    const file=installerPath();
    if(!existsSync(file)||!statSync(file).isFile())return reply.code(404).send({message:"WorkstreamSetup.exe is currently unavailable."});
    return reply.header("Content-Type","application/vnd.microsoft.portable-executable").header("Content-Disposition","attachment; filename=WorkstreamSetup.exe").header("Cache-Control","no-store, max-age=0").send(createReadStream(file));
  });
  app.get("/v1/app/overview",async request=>{
    const actor=await requireEmployer(request), query=z.object({date:dateInput.optional()}).parse(request.query);
    return clean(await operationalData(actor.companyId,query.date));
  });
  app.get("/v1/employees",async request=>{
    const actor=await requireEmployer(request);
    const query=z.object({page:z.coerce.number().int().min(1).default(1),search:z.string().default(""),status:z.string().optional(),monitoringMode:z.string().optional(),department:z.string().optional(),designation:z.string().optional(),deviceStatus:z.string().optional()}).parse(request.query);
    const result=await operationalData(actor.companyId);
    const rows=result.employees.filter(e=>(!query.search||[e.fullName,e.email,e.designation,e.department,e.employeeCode].join(" ").toLowerCase().includes(query.search.toLowerCase()))&&(!query.status||e.workStatus===query.status)&&(!query.monitoringMode||e.monitoringMode===query.monitoringMode)&&(!query.department||e.department===query.department)&&(!query.designation||e.designation===query.designation)&&(!query.deviceStatus||e.deviceStatus===query.deviceStatus));
    return clean({employees:rows.slice((query.page-1)*25,query.page*25),total:rows.length,page:query.page});
  });
  app.get("/v1/employees/:employeeId",async request=>{
    const actor=await requireEmployer(request), employeeId=id.parse((request.params as {employeeId:string}).employeeId);
    const record=await owned("employees",employeeId,actor.companyId);
    return clean({employee:{...record.data,id:employeeId}});
  });
  app.post("/v1/employees",async (request,reply)=>{
    const actor=await requireEmployer(request),value=employeeInput.parse(request.body),employee=db.collection("employees").doc(),code=newCode(),key=digest(code);
    const invitation=db.collection("invitations").doc(),delivery=notificationRecord(actor.companyId,{channel:"EMAIL",recipient:value.email,subject:"Your Workstream invitation",text:inviteText(value.fullName,code)});
    await db.runTransaction(async tx=>{
      const claim=db.collection("email_claims").doc(value.email),lookup=db.collection("setup_codes").doc(key);
      const [email,collision]=await Promise.all([tx.get(claim),tx.get(lookup)]);
      if(email.exists)fail(409,"This email is already registered.");
      if(collision.exists)fail(409,"Please retry employee creation.");
      tx.create(claim,{companyId:actor.companyId,employeeId:employee.id,createdAt:Date.now()});
      tx.create(employee,{...value,companyId:actor.companyId,status:"ACTIVE",setupCodeHash:hashSecret(code),setupCodeKey:key,setupCodeEncrypted:encrypt(code),setupCodeVersion:1,createdAt:Date.now(),updatedAt:Date.now()});
      tx.create(lookup,{employeeId:employee.id,companyId:actor.companyId});
      tx.create(invitation,{...delivery,employeeId:employee.id});
      tx.create(db.collection("audit_logs").doc(),{companyId:actor.companyId,actorUserId:actor.uid,action:"EMPLOYEE_CREATED",targetId:employee.id,createdAt:Date.now()});
    });
    await deliver(invitation);
    return reply.code(201).send({employeeId:employee.id,employeeName:value.fullName,setupCode:code,downloadUrl:installerUrl(),invitationStatus:(await invitation.get()).data()?.status});
  });
  app.patch("/v1/employees/:employeeId",async request=>{
    const actor=await requireEmployer(request),employeeId=id.parse((request.params as {employeeId:string}).employeeId);
    const value=employeeInput.omit({email:true}).parse(request.body);
    const record=await owned("employees",employeeId,actor.companyId);
    await db.runTransaction(async tx=>{
      const current=(await tx.get(record.ref)).data();
      if(!current||current.status!=="ACTIVE")fail(404,"Employee not found.");
      tx.update(record.ref,{...value,updatedAt:Date.now()});
      tx.create(db.collection("audit_logs").doc(),{companyId:actor.companyId,actorUserId:actor.uid,action:"EMPLOYEE_EDITED",targetId:employeeId,oldValue:clean(current),newValue:value,createdAt:Date.now()});
    });return {saved:true};
  });
  app.post("/v1/employees/:employeeId/setup-code",async request=>{
    const actor=await requireEmployer(request),employeeId=id.parse((request.params as {employeeId:string}).employeeId),record=await owned("employees",employeeId,actor.companyId),code=newCode(),key=digest(code);
    await db.runTransaction(async tx=>{
      const current=(await tx.get(record.ref)).data(), lookup=db.collection("setup_codes").doc(key);
      const collision=await tx.get(lookup);
      if(!current||current.status!=="ACTIVE")fail(404,"Employee not found.");
      if(collision.exists)fail(409,"Please retry.");
      if(current.setupCodeKey)tx.delete(db.collection("setup_codes").doc(current.setupCodeKey));
      tx.create(lookup,{employeeId,companyId:actor.companyId});tx.update(record.ref,{setupCodeHash:hashSecret(code),setupCodeKey:key,setupCodeEncrypted:encrypt(code),setupCodeVersion:(current.setupCodeVersion??0)+1,updatedAt:Date.now()});
      tx.create(db.collection("audit_logs").doc(),{companyId:actor.companyId,actorUserId:actor.uid,action:"SETUP_CODE_REGENERATED",targetId:employeeId,createdAt:Date.now()});
    });return {setupCode:code};
  });
  app.post("/v1/employees/:employeeId/invitation",async (request,reply)=>{
    const actor=await requireEmployer(request),employeeId=id.parse((request.params as {employeeId:string}).employeeId);
    const employee=await owned("employees",employeeId,actor.companyId);
    if(!employee.data.setupCodeEncrypted) return reply.code(503).send({message:"Configure notification encryption and regenerate the setup code before emailing an invitation."});
    const code=decrypt(employee.data.setupCodeEncrypted),ref=db.collection("invitations").doc();
    await ref.create({...notificationRecord(actor.companyId,{channel:"EMAIL",recipient:employee.data.email,subject:"Your Workstream invitation",text:inviteText(employee.data.fullName,code)}),employeeId});
    await deliver(ref);return {invitationStatus:(await ref.get()).data()?.status};
  });
  app.delete("/v1/employees/:employeeId",async (request,reply)=>{
    const actor=await requireEmployer(request),employeeId=id.parse((request.params as {employeeId:string}).employeeId),record=await owned("employees",employeeId,actor.companyId);
    await db.runTransaction(async tx=>{
      const [employee,devices]=await Promise.all([tx.get(record.ref),tx.get(db.collection("devices").where("employeeId","==",employeeId))]);const current=employee.data();
      if(!current||current.status!=="ACTIVE")fail(404,"Employee not found.");
      tx.update(record.ref,{status:"DELETED",setupCodeHash:null,setupCodeKey:null,setupCodeEncrypted:null,deletedAt:Date.now()});
      if(current.setupCodeKey)tx.delete(db.collection("setup_codes").doc(current.setupCodeKey));
      for(const device of devices.docs)tx.update(device.ref,{status:"REVOKED",revokedAt:Date.now()});
      tx.delete(db.collection("email_claims").doc(current.email));
      tx.create(db.collection("audit_logs").doc(),{companyId:actor.companyId,actorUserId:actor.uid,action:"EMPLOYEE_DELETED",targetId:employeeId,createdAt:Date.now()});
    });return reply.code(204).send();
  });
}
