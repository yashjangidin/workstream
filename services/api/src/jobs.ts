import type {FastifyInstance} from 'fastify';
import {db,storage,auth} from './firebase.js';
import {digest,fail,companyRecords} from './repository.js';
import {dayBounds,localDate,nextDate,milliseconds} from '@workstream/domain';
import {operationalData} from './operational-data.js';
import {evaluateCompany} from './alert-engine.js';
import {notificationRecord,processNotifications} from './notifications.js';
import {timingSafeEqual} from 'node:crypto';
import {alertRule} from './schemas.js';
import {deliveryChannel} from './notification-channels.js';

export async function scheduledReports(companyId:string){
  const company=(await db.collection('companies').doc(companyId).get()).data()!;
  const today=localDate(Date.now(),company.timezone||'UTC'),yesterday=nextDate(today,-1);
  const localNow=new Intl.DateTimeFormat('en-US',{timeZone:company.timezone||'UTC',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(Date.now());
  const localParts=Object.fromEntries(localNow.map(part=>[part.type,part.value]));
  const minutesNow=Number(localParts.hour)*60+Number(localParts.minute);
  const settings=await db.collection('companies').doc(companyId).collection('settings').get();
  for(const period of ['DAILY_REPORT','WEEKLY_REPORT']){
    const count=period==='WEEKLY_REPORT'?7:1,from=nextDate(today,-count);
    const days: Awaited<ReturnType<typeof operationalData>>[]=[];for(let i=0;i<count;i++)days.push(await operationalData(companyId,nextDate(from,i)));
    for(const recipient of ['employerAlerts','employeeAlerts']){
      const parsed=alertRule.safeParse(settings.docs.find(d=>d.id===recipient)?.data()?.[period]);
      if(!parsed.success||!parsed.data.enabled||parsed.data.activationVersion!==2)continue;
      const rule=parsed.data;
      const trigger=rule.trigger??{}, [hour,minute]=String(trigger.time??(period==='DAILY_REPORT'?'18:00':'09:00')).split(':').map(Number);
      if(Number.isFinite(hour)&&Number.isFinite(minute)&&minutesNow<hour*60+minute)continue;
      if(period==='WEEKLY_REPORT'&&trigger.day&&String(trigger.day)!==localParts.weekday)continue;
      if(period==='DAILY_REPORT'&&Array.isArray(trigger.days)&&!trigger.days.includes(new Date(today+'T12:00:00Z').getUTCDay()))continue;
      const audiences=recipient==='employeeAlerts'?days[0].employees.map(e=>e.id):['company'];
      const employerDestination=recipient==='employerAlerts'&&company.ownerUserId?((await auth.getUser(company.ownerUserId).catch(()=>null))?.email??''):'';
      for(const audience of audiences){
        const rows=days.flatMap(d=>d.employees.filter(e=>audience==='company'||e.id===audience));
        const totals=rows.reduce((s,e)=>({timer:s.timer+e.timerSeconds,idle:s.idle+e.idleSeconds,effective:s.effective+e.effectiveSeconds,required:s.required+e.requiredSeconds}),{timer:0,idle:0,effective:0,required:0});
        const key=digest(companyId+':'+period+':'+recipient+':'+audience+':'+from),ref=db.collection('report_runs').doc(key);
        const message=`${period==='DAILY_REPORT'?'Daily':'Weekly'} Workstream report ${from} to ${yesterday}. Timer: ${totals.timer}s. Idle: ${totals.idle}s. Effective: ${totals.effective}s. Required: ${totals.required}s.`;
        const activeChannels=(await Promise.all(rule.channels.map(async channel=>({channel,config:await deliveryChannel(companyId,channel)})))).filter(entry=>entry.config.enabled);
        if(!activeChannels.length)continue;
        const destination=recipient==='employeeAlerts'?(days[0].employees.find(e=>e.id===audience)?.email??''):employerDestination;
        const records=await Promise.all(activeChannels.filter(entry=>entry.channel!=='DASHBOARD').map(async entry=>({channel:entry.channel,record:await notificationRecord(companyId,{channel:entry.channel,recipient:destination,subject:'Workstream '+period.replaceAll('_',' '),text:message})})));
        await db.runTransaction(async tx=>{if((await tx.get(ref)).exists)return;
          tx.create(ref,{companyId,period,from,to:yesterday,audience,totals,status:'GENERATED',createdAt:Date.now()});
          for(const {channel} of activeChannels){if(channel==='DASHBOARD'){tx.create(db.collection('alerts').doc(digest(key+':dashboard')),{companyId,employeeId:audience==='company'?null:audience,type:period,message,recipient,deliveryStatus:'DELIVERED',channels:['DASHBOARD'],acknowledgedAt:null,createdAt:Date.now()});continue;}
            const record=records.find(entry=>entry.channel===channel)!.record;if(!destination)record.status='NOT_CONFIGURED';tx.create(db.collection('notification_jobs').doc(digest(key+':'+channel)),record);
          }
        });
      }
    }
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
