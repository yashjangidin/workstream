import { z } from "zod";
export const timezone = z.string().refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid time zone.");
export const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(d => Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d);
export const schedule = z.object({
  timezone, requiredDailySeconds: z.number().int().min(60).max(86400),
  workdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).transform(v => [...new Set(v)]),
  idleThresholdSeconds: z.number().int().min(30).max(3600),
  monitoringMode: z.enum(["SIMPLE_TIMER","ACTIVE_MONITORING"]).default("SIMPLE_TIMER"),
  officeStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  officeEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  lateStartDelaySeconds: z.number().int().min(0).max(86400).default(3600)
});
export const employeeInput = schedule.extend({
  fullName: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(254).refine(v => !v.includes("/")),
  phone: z.string().max(40).optional(), designation: z.string().max(120).optional(), department: z.string().max(120).optional(), employeeCode: z.string().max(80).optional()
});
export const ruleInput = z.object({ target: z.enum(["APPLICATION","DOMAIN"]), pattern: z.string().trim().min(1).max(255), classification: z.enum(["PRODUCTIVE","NEUTRAL","NON_PRODUCTIVE"]), enabled: z.boolean(), employeeId: id.nullable().default(null) });
export const alertTypes=["EMPLOYEE_IDLE","EMPLOYEE_RETURNED","LATE_START","AGENT_OFFLINE","AGENT_STOPPED_REPORTING","NON_PRODUCTIVE_SUSTAINED","DAILY_TARGET_PROGRESS","DAILY_TARGET_MISSED","DAILY_REPORT","WEEKLY_REPORT"] as const;
export const alertRule = z.object({ enabled: z.boolean(), channels: z.array(z.enum(["DASHBOARD","EMAIL","TELEGRAM","WHATSAPP"])).min(1), cooldownSeconds: z.number().int().min(60).max(604800).optional(), thresholdSeconds: z.number().int().min(30).max(604800).optional(), trigger: z.record(z.any()).default({}), schedule: z.record(z.any()).optional(), recipient: z.string().max(254).default(""), activationVersion:z.literal(2).optional() });
export const alertSettings = z.record(z.enum(alertTypes), alertRule);
const alert=(channels:string[],trigger:Record<string,unknown>={},cooldownSeconds?:number)=>({enabled:false,activationVersion:2,channels,trigger,...(cooldownSeconds?{cooldownSeconds}: {})});
// A saved rule is not permission to notify. New companies begin fully opt-in.
export const defaultEmployerAlerts={EMPLOYEE_IDLE:alert(["DASHBOARD"],{minutes:10},1800),EMPLOYEE_RETURNED:alert(["DASHBOARD"]),LATE_START:alert(["DASHBOARD"],{minutes:60}),AGENT_OFFLINE:alert(["DASHBOARD"],{minutes:2},1800),AGENT_STOPPED_REPORTING:alert(["DASHBOARD"]),NON_PRODUCTIVE_SUSTAINED:alert(["DASHBOARD"],{minutes:10},1800),DAILY_TARGET_PROGRESS:alert(["DASHBOARD"],{percent:75}),DAILY_TARGET_MISSED:alert(["DASHBOARD"]),DAILY_REPORT:alert(["DASHBOARD"],{time:"18:00",days:[1,2,3,4,5]}),WEEKLY_REPORT:alert(["DASHBOARD"],{time:"09:00",day:"Monday"})};
export const defaultEmployeeAlerts={EMPLOYEE_IDLE:alert(["DASHBOARD"],{minutes:10},1800),EMPLOYEE_RETURNED:alert(["DASHBOARD"]),LATE_START:alert(["DASHBOARD"]),AGENT_OFFLINE:alert(["DASHBOARD"],{minutes:2}),AGENT_STOPPED_REPORTING:alert(["DASHBOARD"]),NON_PRODUCTIVE_SUSTAINED:alert(["DASHBOARD"],{minutes:10},1800),DAILY_TARGET_PROGRESS:alert(["DASHBOARD"],{percent:75}),DAILY_TARGET_MISSED:alert(["DASHBOARD"]),DAILY_REPORT:alert(["DASHBOARD"],{time:"18:00",days:[1,2,3,4,5]}),WEEKLY_REPORT:alert(["DASHBOARD"],{time:"09:00",day:"Monday"})};
export function normaliseAlerts(raw:unknown,defaults:Record<string,unknown>){
  const saved=(raw&&typeof raw==="object"?raw:{}) as Record<string,unknown>;
  return Object.fromEntries(alertTypes.map(type=>{
    const parsed=alertRule.safeParse(saved[type]);
    const fallback=defaults[type] as Record<string,unknown>;
    const value=parsed.success?parsed.data:fallback;
    // Legacy records had no activationVersion. They must fail closed.
    return [type,{...fallback,...value,enabled:value.activationVersion===2?value.enabled:false,activationVersion:2}];
  }));
}
