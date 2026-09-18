import type {FastifyInstance} from 'fastify';
import {db,storage,auth} from './firebase.js';
import {digest,fail,companyRecords} from './repository.js';
import {localDate,nextDate,milliseconds} from '@workstream/domain';
import {operationalData} from './operational-data.js';
import {evaluateCompany} from './alert-engine.js';
import {notificationRecord,processNotifications} from './notifications.js';
import {timingSafeEqual} from 'node:crypto';
import {alertRule,employerReportTypes} from './schemas.js';
import {deliveryChannel} from './notification-channels.js';

export async function scheduledReports(companyId:string){
  const company=(await db.collection('companies').doc(companyId).get()).data()!;
  const today=localDate(Date.now(),company.timezone||'UTC'),yesterday=nextDate(today,-1);
  const localNow=new Intl.DateTimeFormat('en-US',{timeZone:company.timezone||'UTC',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(Date.now());
  const localParts=Object.fromEntries(localNow.map(part=>[part.type,part.value]));
  const minutesNow=Number(localParts.hour)*60+Number(localParts.minute);
  const settings=await db.collection('companies').doc(companyId).collection('settings').get();
  const rules=settings.docs.find(doc=>doc.id==='employerAlerts')?.data()??{};
  const cache=new Map<number,Awaited<ReturnType<typeof operationalData>>[]>();
  const reportDays=async(count:number)=>{
    if(cache.has(count))return cache.get(count)!;
    const from=nextDate(today,-count),days=[];
    for(let index=0;index<count;index++)days.push(await operationalData(companyId,nextDate(from,index)));
    cache.set(count,days);return days;
  };
  const duration=(seconds:number)=>Math.floor(seconds/3600)+'h '+String(Math.floor(seconds%3600/60)).padStart(2,'0')+'m';
  const employerDestination=company.ownerUserId?((await auth.getUser(company.ownerUserId).catch(()=>null))?.email??''):'';
  for(const type of employerReportTypes){
    const parsed=alertRule.safeParse(rules[type]);
    if(!parsed.success||!parsed.data.enabled||parsed.data.activationVersion!==3)continue;
    const rule=parsed.data,weekly=type.startsWith('WEEKLY_'),employeeLevel=type.includes('_EMPLOYEE_'),count=weekly?7:1,from=nextDate(today,-count),trigger=rule.trigger??{};
    const [hour,minute]=String(trigger.time??(weekly?'09:00':'18:00')).split(':').map(Number);
    if(Number.isFinite(hour)&&Number.isFinite(minute)&&minutesNow<hour*60+minute)continue;
    if(weekly&&trigger.day&&String(trigger.day)!==localParts.weekday)continue;
    if(!weekly&&Array.isArray(trigger.days)&&!trigger.days.includes(new Date(today+'T12:00:00Z').getUTCDay()))continue;
    const days=await reportDays(count),rows=days.flatMap(day=>day.employees.map(employee=>({...employee,date:day.date})));
    const sum=(items:typeof rows,key:'timerSeconds'|'idleSeconds'|'effectiveSeconds'|'requiredSeconds'|'sessionCount')=>items.reduce((total,row)=>total+Number(row[key]??0),0);
    const totals={timer:sum(rows,'timerSeconds'),idle:sum(rows,'idleSeconds'),effective:sum(rows,'effectiveSeconds'),required:sum(rows,'requiredSeconds'),sessions:sum(rows,'sessionCount')};
    const productivity=rows.reduce((total,row)=>({productive:total.productive+Number(row.productivity?.PRODUCTIVE??0),neutral:total.neutral+Number(row.productivity?.NEUTRAL??0),nonproductive:total.nonproductive+Number(row.productivity?.NON_PRODUCTIVE??0)}),{productive:0,neutral:0,nonproductive:0});
    const employees=[...new Map(rows.map(row=>[row.id,row])).values()],employeeTotals=employees.map(employee=>{const own=rows.filter(row=>row.id===employee.id);return {employee,own,effective:sum(own,'effectiveSeconds'),required:sum(own,'requiredSeconds')};});
    const targetsMet=employeeTotals.filter(item=>item.effective>=item.required).length,lateStarts=rows.filter(row=>row.lateStart).length,offlineDays=rows.filter(row=>row.deviceStatus==='OFFLINE').length,averageEffective=employees.length?Math.floor(totals.effective/employees.length):0;
    const detail=employeeTotals.map(({employee,own,effective,required})=>{const ownProductivity=own.reduce((total,row)=>({productive:total.productive+Number(row.productivity?.PRODUCTIVE??0),neutral:total.neutral+Number(row.productivity?.NEUTRAL??0),nonproductive:total.nonproductive+Number(row.productivity?.NON_PRODUCTIVE??0)}),{productive:0,neutral:0,nonproductive:0});return employee.fullName+': required '+duration(required)+', timer '+duration(sum(own,'timerSeconds'))+', idle '+duration(sum(own,'idleSeconds'))+', effective '+duration(effective)+', target '+(effective>=required?'met':'missed')+', sessions '+sum(own,'sessionCount')+', days worked '+own.filter(row=>row.timerSeconds>0).length+', late starts '+own.filter(row=>row.lateStart).length+', offline days '+own.filter(row=>row.deviceStatus==='OFFLINE').length+', productive '+duration(ownProductivity.productive)+', neutral '+duration(ownProductivity.neutral)+', nonproductive '+duration(ownProductivity.nonproductive)+'.';}).join('\n');
    const message=employeeLevel?(weekly?'Weekly':'Daily')+' employee report ('+from+' to '+yesterday+').\n'+detail:(weekly?'Weekly':'Daily')+' team report ('+from+' to '+yesterday+'). Employees: '+employees.length+'. Working: '+(days.at(-1)?.totals.working??0)+'. Idle now: '+(days.at(-1)?.totals.idle??0)+'. Timer: '+duration(totals.timer)+'. Idle: '+duration(totals.idle)+'. Effective: '+duration(totals.effective)+'. Average effective: '+duration(averageEffective)+'. Required: '+duration(totals.required)+'. Targets met: '+targetsMet+'/'+employees.length+'. Sessions: '+totals.sessions+'. Late starts: '+lateStarts+'. Offline employee-days: '+offlineDays+'. Productive: '+duration(productivity.productive)+'. Neutral: '+duration(productivity.neutral)+'. Nonproductive: '+duration(productivity.nonproductive)+'.';
    const permitted=rule.channels.filter(channel=>['DASHBOARD','EMAIL','TELEGRAM'].includes(channel));
    const activeChannels=(await Promise.all(permitted.map(async channel=>({channel,config:await deliveryChannel(companyId,channel)})))).filter(entry=>entry.config.enabled);
    if(!activeChannels.length)continue;
    const key=digest(companyId+':'+type+':'+from),ref=db.collection('report_runs').doc(key);
    const records=await Promise.all(activeChannels.filter(entry=>entry.channel!=='DASHBOARD').map(async entry=>({channel:entry.channel,record:await notificationRecord(companyId,{channel:entry.channel,recipient:employerDestination,subject:'Workstream '+type.replaceAll('_',' '),text:message,audience:'EMPLOYER'})})));
    await db.runTransaction(async tx=>{
      if((await tx.get(ref)).exists)return;
      tx.create(ref,{companyId,period:type,from,to:yesterday,audience:'EMPLOYER',totals,productivity,status:'GENERATED',createdAt:Date.now()});
      for(const {channel} of activeChannels){
        if(channel==='DASHBOARD'){tx.create(db.collection('alerts').doc(digest(key+':dashboard')),{companyId,employeeId:null,type,message,recipient:'EMPLOYER',deliveryStatus:'DELIVERED',channels:['DASHBOARD'],acknowledgedAt:null,createdAt:Date.now()});continue;}
        const record=records.find(entry=>entry.channel===channel)!.record;
        if(!employerDestination&&channel==='EMAIL')record.status='NOT_CONFIGURED';
        tx.create(db.collection('notification_jobs').doc(digest(key+':'+channel)),record);
      }
    });
  }
  await processNotifications(companyId);
}

export async function retainScreenshots(companyId:string){
  const cutoff=Date.now()-30*86400000;
  const rows=await companyRecords('screenshots',companyId);
  for(const row of rows){if(milliseconds(row.timestamp)>=cutoff)continue;
    if(typeof row.storagePath!=='string'||!row.storagePath.startsWith(companyId+'/'))continue;
    await storage.bucket().file(row.storagePath).delete({ignoreNotFound:true});
    const batch=db.batch();batch.delete(db.collection('screenshots').doc(row.id));batch.set(db.collection('audit_logs').doc(digest('retention:'+row.id)),{companyId,action:'SCREENSHOT_RETENTION',targetId:row.id,createdAt:Date.now()});await batch.commit();
  }
}
export async function runCompanyJobs(companyId:string){await evaluateCompany(companyId);await scheduledReports(companyId);await retainScreenshots(companyId);}
export async function jobsRoutes(app:FastifyInstance){
  app.post('/v1/jobs/run',async request=>{
    const provided=request.headers.authorization?.replace(/^Bearer /,'')??'',configured=process.env.SCHEDULER_SECRET??'';
    if(configured.length<32||!timingSafeEqual(Buffer.from(digest(provided)),Buffer.from(digest(configured))))fail(401,'Scheduler authorization required.');
    const companies=await db.collection('companies').where('status','==','ACTIVE').get();
    for(const company of companies.docs)await runCompanyJobs(company.id);
    return {completed:true,companies:companies.size};
  });
}
