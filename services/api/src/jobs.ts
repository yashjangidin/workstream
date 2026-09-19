import type {FastifyInstance} from 'fastify';
import {db,storage,auth} from './firebase.js';
import {digest,fail,companyRecords} from './repository.js';
import {localDate,nextDate,milliseconds} from '@workstream/domain';
import {operationalData} from './operational-data.js';
import {notificationRecord,processNotifications} from './notifications.js';
import {timingSafeEqual} from 'node:crypto';
import {alertRule,reportTypes,defaultEmployerAlerts,defaultEmployeeAlerts,normaliseAlerts} from './schemas.js';
import {deliveryChannel} from './notification-channels.js';
import {z} from 'zod';

const formatDuration=(seconds:number)=>Math.floor(seconds/3600)+'h '+String(Math.floor(seconds%3600/60)).padStart(2,'0')+'m';

export async function scheduledReports(companyId:string){
  const company=(await db.collection('companies').doc(companyId).get()).data()!;
  const today=localDate(Date.now(),company.timezone||'UTC'),yesterday=nextDate(today,-1);
  const localNow=new Intl.DateTimeFormat('en-US',{timeZone:company.timezone||'UTC',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(Date.now());
  const localParts=Object.fromEntries(localNow.map(part=>[part.type,part.value]));
  const minutesNow=Number(localParts.hour)*60+Number(localParts.minute);
  const settings=await db.collection('companies').doc(companyId).collection('settings').get();
  const employerRules=normaliseAlerts(settings.docs.find(doc=>doc.id==='employerAlerts')?.data(),defaultEmployerAlerts,reportTypes);
  const employeeRules=normaliseAlerts(settings.docs.find(doc=>doc.id==='employeeAlerts')?.data(),defaultEmployeeAlerts,reportTypes);
  const email=await deliveryChannel(companyId,'EMAIL');
  if(!email.enabled||!email.configured)return;
  const ownerEmail=company.ownerUserId?((await auth.getUser(company.ownerUserId).catch(()=>null))?.email??''):'';
  const employerDestination=email.destination||ownerEmail;
  const cache=new Map<number,Awaited<ReturnType<typeof operationalData>>[]>();
  const reportDays=async(count:number)=>{
    if(cache.has(count))return cache.get(count)!;
    const from=nextDate(today,-count),days=[];
    for(let index=0;index<count;index++)days.push(await operationalData(companyId,nextDate(from,index)));
    cache.set(count,days);return days;
  };
  const isDue=(type:string,rule:z.infer<typeof alertRule>)=>{
    const weekly=type.startsWith('WEEKLY_'),trigger=rule.trigger??{};
    const [hour,minute]=String(trigger.time??(weekly?'09:00':'18:00')).split(':').map(Number);
    if(Number.isFinite(hour)&&Number.isFinite(minute)&&minutesNow<hour*60+minute)return false;
    if(weekly&&trigger.day&&String(trigger.day)!==localParts.weekday)return false;
    if(!weekly&&Array.isArray(trigger.days)&&!trigger.days.includes(new Date(today+'T12:00:00Z').getUTCDay()))return false;
    return true;
  };
  for(const type of reportTypes){
    const employer=alertRule.safeParse(employerRules[type]),employee=alertRule.safeParse(employeeRules[type]);
    const employerEnabled=Boolean(employer.success&&employer.data.enabled&&employer.data.activationVersion===4&&isDue(type,employer.data));
    const employeeEnabled=Boolean(employee.success&&employee.data.enabled&&employee.data.activationVersion===4&&isDue(type,employee.data));
    if(!employerEnabled&&!employeeEnabled)continue;
    const weekly=type.startsWith('WEEKLY_'),count=weekly?7:1,from=nextDate(today,-count),days=await reportDays(count);
    const rows=days.flatMap(day=>day.employees.filter(person=>person.status==='ACTIVE').map(person=>({...person,date:day.date})));
    const employees=[...new Map(rows.map(row=>[row.id,row])).values()];
    const sum=(items:typeof rows,key:'timerSeconds'|'idleSeconds'|'effectiveSeconds'|'requiredSeconds'|'sessionCount')=>items.reduce((total,row)=>total+Number(row[key]??0),0);
    const employeeMessage=(employeeId:string)=>{
      const own=rows.filter(row=>row.id===employeeId),person=own[0];
      const effective=sum(own,'effectiveSeconds'),required=sum(own,'requiredSeconds');
      return 'Workstream '+(weekly?'weekly':'daily')+' report for '+person.fullName+' ('+from+' to '+yesterday+').\nRequired: '+formatDuration(required)+'.\nTimer: '+formatDuration(sum(own,'timerSeconds'))+'.\nIdle: '+formatDuration(sum(own,'idleSeconds'))+'.\nEffective: '+formatDuration(effective)+'.\nTarget: '+(effective>=required?'met':'not met')+'.\nSessions: '+sum(own,'sessionCount')+'.\nDays worked: '+own.filter(row=>row.timerSeconds>0).length+'.';
    };
    const employerMessage='Workstream '+(weekly?'weekly':'daily')+' employee report ('+from+' to '+yesterday+').\n\n'+employees.map(person=>employeeMessage(person.id)).join('\n\n');
    const jobs:Array<{key:string;audience:'EMPLOYEE'|'EMPLOYER';employeeId:string|null;recipient:string;message:string}>=[];
    if(employerEnabled&&employerDestination)jobs.push({key:digest(companyId+':'+type+':EMPLOYER:'+from),audience:'EMPLOYER',employeeId:null,recipient:employerDestination,message:employerMessage});
    if(employeeEnabled)for(const person of employees)if(person.email)jobs.push({key:digest(companyId+':'+type+':EMPLOYEE:'+person.id+':'+from),audience:'EMPLOYEE',employeeId:person.id,recipient:String(person.email),message:employeeMessage(person.id)});
    for(const job of jobs){
      const runRef=db.collection('report_runs').doc(job.key),notificationRef=db.collection('notification_jobs').doc(digest(job.key+':EMAIL'));
      const record=await notificationRecord(companyId,{channel:'EMAIL',recipient:job.recipient,subject:'Workstream '+(weekly?'weekly':'daily')+' employee report',text:job.message,audience:job.audience});
      await db.runTransaction(async tx=>{
        if((await tx.get(runRef)).exists)return;
        tx.create(runRef,{companyId,period:type,from,to:yesterday,audience:job.audience,employeeId:job.employeeId,status:'GENERATED',createdAt:Date.now()});
        tx.create(notificationRef,{...record,employeeId:job.employeeId});
      });
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
export async function runCompanyJobs(companyId:string){await scheduledReports(companyId);await retainScreenshots(companyId);}
export async function jobsRoutes(app:FastifyInstance){
  app.post('/v1/jobs/run',async request=>{
    const provided=request.headers.authorization?.replace(/^Bearer /,'')??'',configured=process.env.SCHEDULER_SECRET??'';
    if(configured.length<32||!timingSafeEqual(Buffer.from(digest(provided)),Buffer.from(digest(configured))))fail(401,'Scheduler authorization required.');
    const companies=await db.collection('companies').where('status','==','ACTIVE').get();
    for(const company of companies.docs)await runCompanyJobs(company.id);
    return {completed:true,companies:companies.size};
  });
}
