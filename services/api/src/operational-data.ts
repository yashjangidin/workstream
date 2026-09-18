import { db } from "./firebase.js";
import { companyRecords } from "./repository.js";
import { calculateTimeTotals, dailyTime, dayBounds, localDate, operationalStatus, targetStatus, milliseconds, type RecordedSession, type RecordedIdle } from "@workstream/domain";
import { config } from "./config.js";

async function reconcileStaleSessions(companyId:string,sessions:any[],devices:any[],now:number) {
  const devicesById=new Map(devices.map(device=>[device.id,device]));
  const closed=new Map<string,number>();
  const stale=sessions.filter(session=>{
    if(session.status!=="ACTIVE")return false;
    const device=devicesById.get(session.deviceId),lastSeen=milliseconds(device?.lastHeartbeatAt);
    return device?.status==="REVOKED"||!Number.isFinite(lastSeen)||now-lastSeen>config.OFFLINE_TIMEOUT*1000;
  });
  await Promise.all(stale.map(async candidate=>{
    await db.runTransaction(async tx=>{
      const sessionRef=db.collection("work_sessions").doc(candidate.id);
      const [sessionDoc,employeeDoc,deviceDoc,idleDocs]=await Promise.all([
        tx.get(sessionRef),
        tx.get(db.collection("employees").doc(candidate.employeeId)),
        tx.get(db.collection("devices").doc(candidate.deviceId)),
        tx.get(db.collection("idle_intervals").where("sessionId","==",candidate.id))
      ]);
      const session=sessionDoc.data(),device=deviceDoc.data();
      if(!session||session.status!=="ACTIVE"||session.companyId!==companyId)return;
      const lastSeen=milliseconds(device?.lastHeartbeatAt);
      if(device?.status!=="REVOKED"&&Number.isFinite(lastSeen)&&now-lastSeen<=config.OFFLINE_TIMEOUT*1000)return;
      // Never create time after the last confirmed device heartbeat.
      const stoppedAt=Math.max(milliseconds(session.startedAt),Math.min(now,Number.isFinite(lastSeen)?lastSeen:milliseconds(session.startedAt)));
      const intervals=idleDocs.docs.map(doc=>{const idle=doc.data();return {startedAt:new Date(idle.startedAt),endedAt:new Date(idle.endedAt??stoppedAt)};});
      const totals=calculateTimeTotals({startedAt:new Date(session.startedAt),endedAt:new Date(stoppedAt)},intervals);
      for(const idle of idleDocs.docs)if(!idle.data().endedAt)tx.update(idle.ref,{endedAt:stoppedAt});
      tx.update(sessionRef,{status:"COMPLETED",stoppedAt,...totals,updatedAt:now,closedBy:"STALE_DEVICE_TIMEOUT"});
      if(deviceDoc.exists)tx.update(deviceDoc.ref,{timerState:"STOPPED"});
      if(employeeDoc.data()?.activeSessionId===candidate.id)tx.update(employeeDoc.ref,{activeSessionId:null});
      closed.set(candidate.id,stoppedAt);
    });
  }));
  return closed;
}

export async function operationalData(companyId: string, date?: string) {
  const company = (await db.collection("companies").doc(companyId).get()).data()!;
  const timezone = company.timezone || "UTC", now = Date.now(), selected = date || localDate(now,timezone);
  const {start,end} = dayBounds(selected,timezone);
  const [employees,sessions,idle,devices,activity,alerts,adjustments] = await Promise.all(["employees","work_sessions","idle_intervals","devices","activity_events","alerts","time_adjustments"].map(c => companyRecords(c,companyId)));
  const employerAlerts=alerts.filter(alert=>alert.recipient!=="EMPLOYEE");
  const staleClosures=await reconcileStaleSessions(companyId,sessions,devices,now);
  const reportingSessions=sessions.map(session=>staleClosures.has(session.id)?{...session,status:"COMPLETED",stoppedAt:staleClosures.get(session.id)!}:session);
  const rows = employees.filter(e=>e.status !== "DELETED").map(employee => {
    const ownSessions = reportingSessions.filter(s=>s.employeeId===employee.id).map(s=>{const adjustment=adjustments.find(a=>a.sessionId===s.id);return adjustment?{...s,startedAt:adjustment.startedAt,stoppedAt:adjustment.stoppedAt}:s;});
    for(const a of adjustments.filter(a=>a.employeeId===employee.id&&!a.sessionId))ownSessions.push({...a,status:'COMPLETED',deviceId:'MANUAL',id:a.id});
    const ownIdle = idle.filter(i=>i.employeeId===employee.id);
    const active = ownSessions.find(s=>s.status==="ACTIVE");
    const paired = devices.filter(d=>d.employeeId===employee.id).sort((a,b)=>milliseconds(b.lastHeartbeatAt)-milliseconds(a.lastHeartbeatAt));
    const device = paired.find(d=>d.id===active?.deviceId) ?? paired.find(d=>d.status!=="REVOKED") ?? paired[0];
    const time = dailyTime(ownSessions as RecordedSession[],ownIdle as RecordedIdle[],start,end,now);
    const weekday = new Date(selected+"T12:00:00Z").getUTCDay();
    const requiredSeconds = employee.workdays.includes(weekday) ? employee.requiredDailySeconds : 0;
    const productivity = { PRODUCTIVE:0, NEUTRAL:0, NON_PRODUCTIVE:0 };
    const intervals = activity.filter(a=>a.employeeId===employee.id).sort((a,b)=>milliseconds(a.startedAt)-milliseconds(b.startedAt));
    // Activity is recorded as non-overlapping intervals; clip to the report day.
    let coveredUntil = start;
    for (const a of intervals) { const from=Math.max(start,coveredUntil,milliseconds(a.startedAt)), to=Math.min(end,now,milliseconds(a.endedAt)); if(to>from){ productivity[a.classification as keyof typeof productivity] += Math.floor((to-from)/1000); coveredUntil=to; } }
    // Never return the device credential hash to an employer browser.
    const deviceSummary=device?{id:device.id,name:device.name,platform:device.platform,status:device.status,lastHeartbeatAt:device.lastHeartbeatAt,lastSyncAt:device.lastSyncAt,timerState:device.timerState,agentVersion:device.agentVersion}:null;
    const activeIdle=ownIdle.find(i=>i.sessionId===active?.id&&!i.endedAt);
    const sessionCount=ownSessions.filter(session=>milliseconds(session.startedAt)<end&&milliseconds(session.stoppedAt??now)>=start).length;
    const firstStart=ownSessions.filter(session=>milliseconds(session.startedAt)>=start&&milliseconds(session.startedAt)<end).map(session=>milliseconds(session.startedAt)).sort((a,b)=>a-b)[0];
    const firstParts=firstStart?new Intl.DateTimeFormat("en-GB",{timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(firstStart).split(":").map(Number):null,office=employee.officeStart?String(employee.officeStart).split(":").map(Number):null;
    const lateStart=Boolean(firstParts&&office&&firstParts[0]*60+firstParts[1]>office[0]*60+office[1]+Number(employee.lateStartDelaySeconds??0)/60);
    return { ...employee, ...time, ...operationalStatus(device as {status:string;lastHeartbeatAt?:unknown},!!active,!!activeIdle,now,config.OFFLINE_TIMEOUT), device:deviceSummary, activeSessionStartedAt:active?.startedAt??null, activeIdleStartedAt:activeIdle?.startedAt??null, requiredSeconds, remainingSeconds:Math.max(0,requiredSeconds-time.effectiveSeconds), targetStatus:targetStatus(time.timerSeconds,time.effectiveSeconds,requiredSeconds,end,now), productivity, sessionCount, lateStart, alertCount:employerAlerts.filter(a=>a.employeeId===employee.id&&milliseconds(a.createdAt)>=start&&milliseconds(a.createdAt)<end).length };
  });
  const todayAlerts = employerAlerts.filter(a=>milliseconds(a.createdAt)>=start&&milliseconds(a.createdAt)<end);
  return { company:{id:companyId,name:company.name,timezone}, date:selected, generatedAt:now, employees:rows,
    totals:{employees:rows.length, working:rows.filter(r=>r.workStatus==="WORKING").length,idle:rows.filter(r=>r.workStatus==="IDLE").length,notWorking:rows.filter(r=>r.workStatus==="NOT_WORKING").length,offline:rows.filter(r=>r.deviceStatus==="OFFLINE").length,belowTarget:rows.filter(r=>r.targetStatus!=="COMPLETED").length,alerts:todayAlerts.length,timerSeconds:rows.reduce((s,r)=>s+r.timerSeconds,0),idleSeconds:rows.reduce((s,r)=>s+r.idleSeconds,0),effectiveSeconds:rows.reduce((s,r)=>s+r.effectiveSeconds,0)},
    alerts:todayAlerts.sort((a,b)=>milliseconds(b.createdAt)-milliseconds(a.createdAt)).slice(0,8) };
}
