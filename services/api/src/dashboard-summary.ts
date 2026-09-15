import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase.js";
import { operationalData } from "./operational-data.js";

// The home screen reads a single compact current-day projection, never every
// historical session, device, alert, and activity record.
const refFor=(companyId:string)=>db.collection("dashboard_summaries").doc(companyId);

function serialise(overview:any) {
  return {summaryVersion:1,companyId:overview.company.id,company:overview.company,date:overview.date,
    generatedAt:overview.generatedAt,employees:Object.fromEntries(overview.employees.map((employee:any)=>[employee.id,employee])),
    totals:overview.totals,alerts:overview.alerts};
}

function deserialise(value:any) { return {...value,employees:Object.values(value.employees??{})}; }

/** First visit seeds the compact document from existing data; later home-screen
 * refreshes read only this document. */
export async function dashboardSummary(companyId:string,date?:string) {
  const ref=refFor(companyId),snapshot=await ref.get(),value=snapshot.data();
  if(value?.summaryVersion===1&&value.company&&(!date||value.date===date)) return deserialise(value);
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
    timerStatus:"STOPPED",workStatus:"NOT_WORKING",activeSessionStartedAt:null,activeIdleStartedAt:null
  }},totals:{timerSeconds:increment(totals.timerSeconds),idleSeconds:increment(totals.idleSeconds),effectiveSeconds:increment(totals.effectiveSeconds)}},{merge:true});
}

// Company-admin changes are rare. Rebuilding once afterwards is safer than
// trying to apply a partial employee-profile patch to a cached projection.
export async function invalidateDashboardSummary(companyId:string) {
  await refFor(companyId).delete();
}
