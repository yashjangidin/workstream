import { db,auth } from "./firebase.js";
import { digest,companyRecords } from "./repository.js";
import { operationalData } from "./operational-data.js";
import { milliseconds,dayBounds } from "@workstream/domain";
import type { FastifyInstance } from "fastify";
import { requireEmployer } from "./security.js";
import { alertRule } from "./schemas.js";
import {notificationRecord,processNotifications} from './notifications.js';
import {deliveryChannel} from './notification-channels.js';
const minutesFor=(rule:unknown,fallback:number)=>{const value=rule as {trigger?:{minutes?:unknown};thresholdSeconds?:unknown}|undefined;const minutes=Number(value?.trigger?.minutes??(Number(value?.thresholdSeconds??fallback*60)/60));return Number.isFinite(minutes)&&minutes>0?minutes:fallback;};
const cooldownFor=(rule:unknown,fallback=30)=>{const seconds=Number((rule as {cooldownSeconds?:unknown}|undefined)?.cooldownSeconds??fallback*60);return Number.isFinite(seconds)&&seconds>=60?seconds: fallback*60;};
const progressFor=(rule:unknown)=>{
  const percent=Number((rule as {trigger?:{percent?:unknown}}|undefined)?.trigger?.percent??75);
  return Number.isFinite(percent)?Math.min(100,Math.max(1,percent)):75;
};

/** Every alert and delivery is explicitly opt-in. Disabled channels create no dashboard alert or job. */
async function emit(companyId:string,employeeId:string,type:string,recipient:string,message:string,period:string,raw:unknown){
  const rule=alertRule.safeParse(raw);if(!rule.success||!rule.data.enabled||rule.data.activationVersion!==2)return;
  let destination=rule.data.recipient;
  if(!destination&&rule.data.channels.some(channel=>channel!=="DASHBOARD")){
    if(recipient==="EMPLOYEE") destination=(await db.collection("employees").doc(employeeId).get()).data()?.email??"";
    else {
      const company=(await db.collection("companies").doc(companyId).get()).data();
      if(company?.ownerUserId){try{destination=(await auth.getUser(company.ownerUserId)).email??"";}catch{destination="";}}
    }
  }
  const enabledChannels=(await Promise.all(rule.data.channels.map(async channel=>({channel,config:await deliveryChannel(companyId,channel)})))).filter(entry=>entry.config.enabled);
  if(!enabledChannels.length)return;
  const now=Date.now(),key=digest(companyId+":"+employeeId+":"+type+":"+recipient),window=db.collection("alert_cooldowns").doc(key),alert=db.collection("alerts").doc(digest(key+":"+period));
  const records=await Promise.all(enabledChannels.filter(entry=>entry.channel!=="DASHBOARD").map(async entry=>({channel:entry.channel,record:await notificationRecord(companyId,{channel:entry.channel,recipient:destination,subject:'Workstream: '+type.replaceAll('_',' '),text:message})})));
  await db.runTransaction(async tx=>{
    const [old,previous]=await Promise.all([tx.get(window),tx.get(alert)]);
    if(previous.exists||now-(old.data()?.lastSentAt??0)<cooldownFor(rule.data)*1000)return;
    tx.set(window,{companyId,lastSentAt:now});
    const deliveries=enabledChannels.map(({channel})=>{
      if(channel==='DASHBOARD')return {channel,status:'DELIVERED'};
      const ref=db.collection('notification_jobs').doc(digest(alert.id+':'+channel));
      const record=records.find(entry=>entry.channel===channel)!.record;
      if(!destination)record.status='NOT_CONFIGURED';
      tx.create(ref,{...record,alertId:alert.id,employeeId});return {channel,status:record.status,jobId:ref.id};
    });
    tx.create(alert,{companyId,employeeId,type,recipient,message,channels:rule.data.channels,deliveryStatus:deliveries.every(d=>d.status==='DELIVERED')?'DELIVERED':'PARTIAL',deliveries,acknowledgedAt:null,createdAt:now});
  });
}
export async function evaluateCompany(companyId:string){
  const overview=await operationalData(companyId),now=Date.now();
  const settings=await db.collection("companies").doc(companyId).collection("settings").get();
  const [idle,activity]=await Promise.all(['idle_intervals','activity_events'].map(c=>companyRecords(c,companyId)));
  for(const employee of overview.employees){
    for(const recipient of ["EMPLOYER","EMPLOYEE"]){
      const rules=settings.docs.find(d=>d.id===(recipient==="EMPLOYER"?"employerAlerts":"employeeAlerts"))?.data()??{};
      const pendingIdle=idle.find(i=>i.employeeId===employee.id&&!i.endedAt);
      if(pendingIdle&&now-milliseconds(pendingIdle.startedAt)>=minutesFor(rules.EMPLOYEE_IDLE,2)*60000)
        await emit(companyId,employee.id,"EMPLOYEE_IDLE",recipient,employee.fullName+" is idle.",pendingIdle.id,rules.EMPLOYEE_IDLE);
      const returned=idle.filter(i=>i.employeeId===employee.id&&i.endedAt&&now-milliseconds(i.endedAt)<300000).sort((a,b)=>milliseconds(b.endedAt)-milliseconds(a.endedAt))[0];
      if(returned&&employee.workStatus==='WORKING')await emit(companyId,employee.id,'EMPLOYEE_RETURNED',recipient,employee.fullName+' returned from idle.',returned.id,rules.EMPLOYEE_RETURNED);
      const recent=activity.filter(i=>i.employeeId===employee.id).sort((a,b)=>milliseconds(b.endedAt)-milliseconds(a.endedAt));
      let continuous=0,until=now;
      for(const event of recent){if(event.classification!=='NON_PRODUCTIVE'||until-milliseconds(event.endedAt)>30000)break;continuous+=Math.max(0,Math.min(until,milliseconds(event.endedAt))-milliseconds(event.startedAt));until=milliseconds(event.startedAt);}
      if(continuous>=minutesFor(rules.NON_PRODUCTIVE_SUSTAINED,10)*60000)await emit(companyId,employee.id,'NON_PRODUCTIVE_SUSTAINED',recipient,employee.fullName+' has sustained nonproductive activity.',String(until),rules.NON_PRODUCTIVE_SUSTAINED);
      if(employee.deviceStatus==="OFFLINE"){
        const period=String(employee.device?.lastHeartbeatAt);
        if(recipient==="EMPLOYER")await emit(companyId,employee.id,"AGENT_OFFLINE",recipient,"Workstream agent is offline for "+employee.fullName+".",period,rules.AGENT_OFFLINE);
        if(employee.timerStatus==="RUNNING")await emit(companyId,employee.id,"AGENT_STOPPED_REPORTING",recipient,"Workstream agent has stopped reporting for "+employee.fullName+".",period,rules.AGENT_STOPPED_REPORTING);
      }
      const progress=progressFor(rules.DAILY_TARGET_PROGRESS);
      if(employee.requiredSeconds>0&&employee.effectiveSeconds>=employee.requiredSeconds*progress/100)
        await emit(companyId,employee.id,"DAILY_TARGET_PROGRESS",recipient,employee.fullName+" has reached "+progress+"% of the daily effective-work target.",overview.date+":"+progress,rules.DAILY_TARGET_PROGRESS);
      const {start}=dayBounds(overview.date,overview.company.timezone);
      const parts=new Intl.DateTimeFormat("en-GB",{timeZone:overview.company.timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now).split(":").map(Number);
      if(employee.officeStart&&employee.requiredSeconds>0&&employee.timerSeconds===0){
        const office=String(employee.officeStart).split(":").map(Number);
        if(parts[0]*60+parts[1]>=office[0]*60+office[1]+Number(employee.lateStartDelaySeconds??3600)/60)await emit(companyId,employee.id,"LATE_START",recipient,employee.fullName+" has not started today's timer.",overview.date,rules.LATE_START);
      }
      if(employee.officeEnd&&employee.remainingSeconds>0){
        const office=String(employee.officeEnd).split(":").map(Number);
        if(parts[0]*60+parts[1]>=office[0]*60+office[1])await emit(companyId,employee.id,"DAILY_TARGET_MISSED",recipient,employee.fullName+" is below the daily target.",overview.date,rules.DAILY_TARGET_MISSED);
      }
    }
  }
  await processNotifications(companyId);
  const alerts=await companyRecords('alerts',companyId);
  for(const alert of alerts){
    if(!Array.isArray(alert.deliveries))continue;
    const deliveries=await Promise.all(alert.deliveries.map(async (d:{jobId?:string;status:string})=>d.jobId?{...d,status:(await db.collection('notification_jobs').doc(d.jobId).get()).data()?.status??d.status}:d));
    if(JSON.stringify(deliveries)!==JSON.stringify(alert.deliveries))await db.collection('alerts').doc(alert.id).update({deliveries,deliveryStatus:deliveries.every(d=>d.status==='DELIVERED')?'DELIVERED':'PARTIAL'});
  }
}
export async function alertJobRoutes(app:FastifyInstance){
  app.post("/v1/jobs/evaluate",async request=>{const a=await requireEmployer(request);await evaluateCompany(a.companyId);return {evaluated:true};});
}
