import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {db} from './firebase.js';
import {requireDevice} from './device-api.js';
import {requireEmployer} from './security.js';
import {id} from './schemas.js';
import {owned,fail,clean,companyRecords,digest} from './repository.js';
export async function correctionRoutes(app:FastifyInstance){
  app.post('/v1/device/corrections',async request=>{
    const d=await requireDevice(request),body=z.object({operationId:id,sessionId:id.nullable(),startedAt:z.number().int().positive(),stoppedAt:z.number().int().positive(),reason:z.string().trim().min(10).max(2000)}).parse(request.body);
    if(body.stoppedAt<=body.startedAt||body.stoppedAt>Date.now()||body.stoppedAt-body.startedAt>86400000)fail(400,'Choose a past interval of no more than 24 hours.');
    const ref=db.collection('time_corrections').doc(body.operationId);
    await db.runTransaction(async tx=>{
      const [existing,device,session]=await Promise.all([tx.get(ref),tx.get(d.ref),body.sessionId?tx.get(db.collection('work_sessions').doc(body.sessionId)):Promise.resolve(null)]);
      if(device.data()?.status==='REVOKED')fail(401,'Device revoked.');
      if(body.sessionId&&(!session?.exists||session.data()?.employeeId!==d.employeeId))fail(404,'Session not found.');
      if(session?.data()?.status==='ACTIVE')fail(409,'Stop the session before requesting a correction.');
      if(existing.exists){if(existing.data()?.deviceId!==d.deviceId||existing.data()?.requestHash!==digest(JSON.stringify(body)))fail(409,'Correction ID conflict.');return;}
      tx.create(ref,{companyId:d.companyId,employeeId:d.employeeId,deviceId:d.deviceId,sessionId:body.sessionId,requested:{startedAt:body.startedAt,stoppedAt:body.stoppedAt},original:session?{startedAt:session.data()?.startedAt,stoppedAt:session.data()?.stoppedAt}:null,reason:body.reason,status:'PENDING',requestHash:digest(JSON.stringify(body)),createdAt:Date.now()});
    });return {requested:true};
  });
  app.get('/v1/corrections',async request=>{const a=await requireEmployer(request),q=z.object({employeeId:id.optional()}).parse(request.query);return clean({corrections:(await companyRecords('time_corrections',a.companyId)).filter(c=>!q.employeeId||c.employeeId===q.employeeId).sort((a,b)=>Number(b.createdAt)-Number(a.createdAt))});});
  app.post('/v1/corrections/:id/review',async request=>{
    const a=await requireEmployer(request),record=await owned('time_corrections',id.parse((request.params as {id:string}).id),a.companyId),body=z.object({decision:z.enum(['APPROVED','REJECTED']),reason:z.string().trim().min(3).max(2000)}).parse(request.body);
    await db.runTransaction(async tx=>{
      const correction=(await tx.get(record.ref)).data()!;
      const target=db.collection('time_adjustments').doc(correction.sessionId??record.id),previous=await tx.get(target);
      if(correction.status!== 'PENDING'){if(correction.status===body.decision)return;fail(409,'This correction was already reviewed.');}
      tx.update(record.ref,{status:body.decision,reviewer:a.uid,reviewReason:body.reason,reviewedAt:Date.now()});
      if(body.decision==='APPROVED')tx.set(target,{companyId:a.companyId,employeeId:correction.employeeId,sessionId:correction.sessionId,correctionId:record.id,...correction.requested,reviewedAt:Date.now()});
      tx.create(db.collection('audit_logs').doc(),{companyId:a.companyId,actorUserId:a.uid,action:'CORRECTION_'+body.decision,targetId:record.id,previousAdjustment:clean(previous.data()),requested:correction.requested,reason:body.reason,createdAt:Date.now()});
    });return {reviewed:true};
  });
}
