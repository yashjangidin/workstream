import { db } from "./firebase.js";
import { companyRecords } from "./repository.js";
import { dailyTime, dayBounds, localDate, operationalStatus, targetStatus, milliseconds, type RecordedSession, type RecordedIdle } from "@workstream/domain";
import { config } from "./config.js";

export async function operationalData(companyId: string, date?: string) {
  const company = (await db.collection("companies").doc(companyId).get()).data()!;
  const timezone = company.timezone || "UTC", now = Date.now(), selected = date || localDate(now,timezone);
  const {start,end} = dayBounds(selected,timezone);
  const [employees,sessions,idle,devices,activity,alerts,adjustments] = await Promise.all(["employees","work_sessions","idle_intervals","devices","activity_events","alerts","time_adjustments"].map(c => companyRecords(c,companyId)));
  const rows = employees.filter(e=>e.status !== "DELETED").map(employee => {
    const ownSessions = sessions.filter(s=>s.employeeId===employee.id).map(s=>{const adjustment=adjustments.find(a=>a.sessionId===s.id);return adjustment?{...s,startedAt:adjustment.startedAt,stoppedAt:adjustment.stoppedAt}:s;});
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
    return { ...employee, ...time, ...operationalStatus(device as {status:string;lastHeartbeatAt?:unknown},!!active,!!ownIdle.find(i=>i.sessionId===active?.id&&!i.endedAt),now,config.OFFLINE_TIMEOUT), device:device??null, requiredSeconds, remainingSeconds:Math.max(0,requiredSeconds-time.effectiveSeconds), targetStatus:targetStatus(time.timerSeconds,time.effectiveSeconds,requiredSeconds,end,now), productivity, alertCount:alerts.filter(a=>a.employeeId===employee.id&&milliseconds(a.createdAt)>=start&&milliseconds(a.createdAt)<end).length };
  });
  const todayAlerts = alerts.filter(a=>milliseconds(a.createdAt)>=start&&milliseconds(a.createdAt)<end);
  return { company:{id:companyId,name:company.name,timezone}, date:selected, generatedAt:now, employees:rows,
    totals:{employees:rows.length, working:rows.filter(r=>r.workStatus==="WORKING").length,idle:rows.filter(r=>r.workStatus==="IDLE").length,notWorking:rows.filter(r=>r.workStatus==="NOT_WORKING").length,offline:rows.filter(r=>r.deviceStatus==="OFFLINE").length,belowTarget:rows.filter(r=>r.targetStatus!=="COMPLETED").length,alerts:todayAlerts.length,timerSeconds:rows.reduce((s,r)=>s+r.timerSeconds,0),idleSeconds:rows.reduce((s,r)=>s+r.idleSeconds,0),effectiveSeconds:rows.reduce((s,r)=>s+r.effectiveSeconds,0)},
    alerts:todayAlerts.sort((a,b)=>milliseconds(b.createdAt)-milliseconds(a.createdAt)).slice(0,8) };
}
