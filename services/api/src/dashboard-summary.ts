import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase.js";
import { operationalData } from "./operational-data.js";

// The home screen reads a single compact current-day projection, never every
// historical session, device, alert, and activity record.
const refFor=(companyId:string)=>db.collection("dashboard_summaries").doc(companyId);

function serialise(overview:any) {
  return {summaryVersion:2,companyId:overview.company.id,company:overview.company,date:overview.date,
    generatedAt:overview.generatedAt,employees:Object.fromEntries(overview.employees.map((employee:any)=>[employee.id,employee])),
    totals:overview.totals,alerts:overview.alerts};
}

function deserialise(value:any) {
  const now=Date.now(), generatedAt=Number(value.generatedAt)||now;
  const employees=Object.values(value.employees??{}).map((raw:any)=>{
    const employee={...raw};
    if(employee.timerStatus==="RUNNING"&&employee.activeSessionStartedAt){
      // timerSeconds already contains time accrued at the snapshot. Only add
      // time since that snapshot (or since this session was started). Idle
      // intervals for the live session are held in the same small document so
      // the overview uses the exact same timer - idle calculation as reports.
      const anchor=Math.max(generatedAt,Number(employee.activeSessionSnapshotAt)||Number(employee.activeSessionStartedAt));
      const extra=Math.max(0,Math.floor((now-anchor)/1000));
      const savedIntervals=Object.values(employee.liveIdleIntervals??{});
      // A version-2 cache seeded during an already-open idle interval has no
      // interval ID yet, so its explicit active-idle timestamp is the source.
      const liveIntervals=savedIntervals.length?savedIntervals:(employee.activeIdleStartedAt?[{startedAt:employee.activeIdleStartedAt,endedAt:null}]:[]);
      const liveIdleSeconds=liveIntervals.reduce((sum:number,rawInterval:any)=>{
        const startedAt=Number(rawInterval?.startedAt), endedAt=rawInterval?.endedAt==null?now:Number(rawInterval.endedAt);
        if(!Number.isFinite(startedAt)||!Number.isFinite(endedAt))return sum;
        return sum+Math.max(0,Math.floor((Math.min(now,endedAt)-Math.max(anchor,startedAt))/1000));
      },0);
      employee.timerSeconds=(Number(employee.timerSeconds)||0)+extra;
      employee.idleSeconds=(Number(employee.idleSeconds)||0)+liveIdleSeconds;
      employee.effectiveSeconds=(Number(employee.effectiveSeconds)||0)+Math.max(0,extra-liveIdleSeconds);
      employee.remainingSeconds=Math.max(0,(Number(employee.requiredSeconds)||0)-employee.effectiveSeconds);
    }
    return employee;
  });
  const count=(status:string)=>employees.filter((employee:any)=>employee.workStatus===status).length;
  return {...value,employees,generatedAt:now,totals:{...value.totals,
    employees:employees.length,working:count("WORKING"),idle:count("IDLE"),notWorking:count("NOT_WORKING"),offline:count("OFFLINE"),
    timerSeconds:employees.reduce((sum:number,employee:any)=>sum+(Number(employee.timerSeconds)||0),0),
    idleSeconds:employees.reduce((sum:number,employee:any)=>sum+(Number(employee.idleSeconds)||0),0),
    effectiveSeconds:employees.reduce((sum:number,employee:any)=>sum+(Number(employee.effectiveSeconds)||0),0)}};
}

/** First visit seeds the compact document from existing data; later home-screen
 * refreshes read only this document. */
export async function dashboardSummary(companyId:string,date?:string) {
  const ref=refFor(companyId),snapshot=await ref.get(),value=snapshot.data();
  if(value?.summaryVersion===2&&value.company&&(!date||value.date===date)) return deserialise(value);
  const overview=await operationalData(companyId,date);
  await ref.set(serialise(overview));
  return overview;
}

// These helpers let device events update a compact live projection without a
// collection scan. A document created before its first dashboard visit is
// rebuilt safely by dashboardSummary.
export async function patchDashboardEmployee(companyId:string,employeeId:string,patch:Record<string,unknown>) {
  await refFor(companyId).set({companyId,updatedAt:Date.now(),employees:{[employeeId]:patch}},{merge:true});
}

export async function addDashboardTime(companyId:string,employeeId:string,totals:{timerSeconds:number;idleSeconds:number;effectiveSeconds:number}) {
  const increment=(value:number)=>FieldValue.increment(value);
  await refFor(companyId).set({companyId,updatedAt:Date.now(),employees:{[employeeId]:{
    timerSeconds:increment(totals.timerSeconds),idleSeconds:increment(totals.idleSeconds),effectiveSeconds:increment(totals.effectiveSeconds),
    timerStatus:"STOPPED",workStatus:"NOT_WORKING",activeSessionStartedAt:null,activeIdleStartedAt:null,liveIdleIntervals:FieldValue.delete()
  }},totals:{timerSeconds:increment(totals.timerSeconds),idleSeconds:increment(totals.idleSeconds),effectiveSeconds:increment(totals.effectiveSeconds)}},{merge:true});
}

// Company-admin changes are rare. Rebuilding once afterwards is safer than
// trying to apply a partial employee-profile patch to a cached projection.
export async function invalidateDashboardSummary(companyId:string) {
  await refFor(companyId).delete();
}
