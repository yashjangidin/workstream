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
export const alertTypes=["EMPLOYEE_IDLE","EMPLOYEE_RETURNED","LATE_START","AGENT_OFFLINE","AGENT_STOPPED_REPORTING","NON_PRODUCTIVE_SUSTAINED","DAILY_TARGET_PROGRESS","DAILY_TARGET_MISSED","DAILY_REPORT","WEEKLY_REPORT","DAILY_TEAM_REPORT","DAILY_EMPLOYEE_REPORT","WEEKLY_TEAM_REPORT","WEEKLY_EMPLOYEE_REPORT"] as const;
export const employeeAlertTypes=["EMPLOYEE_IDLE","LATE_START","DAILY_TARGET_MISSED"] as const;
export const employerEventAlertTypes=["EMPLOYEE_IDLE","LATE_START","AGENT_OFFLINE","AGENT_STOPPED_REPORTING","DAILY_TARGET_MISSED"] as const;
export const employerReportTypes=["DAILY_TEAM_REPORT","DAILY_EMPLOYEE_REPORT","WEEKLY_TEAM_REPORT","WEEKLY_EMPLOYEE_REPORT"] as const;
export const employerAlertTypes=[...employerEventAlertTypes,...employerReportTypes] as const;
export const alertRule = z.object({ enabled: z.boolean(), channels: z.array(z.enum(["WINDOWS_AGENT","DASHBOARD","EMAIL","TELEGRAM","WHATSAPP"])).min(1), cooldownSeconds: z.number().int().min(60).max(604800).optional(), thresholdSeconds: z.number().int().min(30).max(604800).optional(), trigger: z.record(z.any()).default({}), schedule: z.record(z.any()).optional(), recipient: z.string().max(254).default(""), activationVersion:z.literal(3).optional() });
export const alertSettings = z.record(z.enum(alertTypes), alertRule);
const alert=(channels:string[],trigger:Record<string,unknown>={},cooldownSeconds?:number)=>({enabled:false,activationVersion:3,channels,trigger,...(cooldownSeconds?{cooldownSeconds}: {})});
// A saved rule is not permission to notify. New companies begin fully opt-in.
export const defaultEmployerAlerts={EMPLOYEE_IDLE:alert(["DASHBOARD"],{minutes:10},1800),LATE_START:alert(["DASHBOARD"],{minutes:60}),AGENT_OFFLINE:alert(["DASHBOARD"],{minutes:2},1800),AGENT_STOPPED_REPORTING:alert(["DASHBOARD"]),DAILY_TARGET_MISSED:alert(["DASHBOARD"]),DAILY_TEAM_REPORT:alert(["DASHBOARD"],{time:"18:00",days:[1,2,3,4,5]}),DAILY_EMPLOYEE_REPORT:alert(["DASHBOARD"],{time:"18:00",days:[1,2,3,4,5]}),WEEKLY_TEAM_REPORT:alert(["DASHBOARD"],{time:"09:00",day:"Monday"}),WEEKLY_EMPLOYEE_REPORT:alert(["DASHBOARD"],{time:"09:00",day:"Monday"})};
export const defaultEmployeeAlerts={EMPLOYEE_IDLE:alert(["WINDOWS_AGENT"],{minutes:10},1800),LATE_START:alert(["WINDOWS_AGENT"],{minutes:60}),DAILY_TARGET_MISSED:alert(["WINDOWS_AGENT"])};
export function sanitiseAlertSettings(raw:unknown,audience:"EMPLOYEE"|"EMPLOYER"){
  const parsed=alertSettings.parse(raw),employee=audience==="EMPLOYEE",types=employee?employeeAlertTypes:employerAlertTypes,allowed=employee?["WINDOWS_AGENT","EMAIL"]:["DASHBOARD","EMAIL","TELEGRAM"],fallback=(employee?defaultEmployeeAlerts:defaultEmployerAlerts) as Record<string,{channels:string[]}>;
  return Object.fromEntries(types.map(type=>{const rule=parsed[type]??fallback[type],channels=rule.channels.filter((channel:string)=>allowed.includes(channel));if(!channels.length)throw Object.assign(new Error("Select at least one supported delivery channel."),{statusCode:400});return [type,{...rule,channels,activationVersion:3}];}));
}
export function normaliseAlerts(raw:unknown,defaults:Record<string,unknown>,types:readonly string[]){
  const saved=(raw&&typeof raw==="object"?raw:{}) as Record<string,unknown>;
  return Object.fromEntries(types.map(type=>{
    const parsed=alertRule.safeParse(saved[type]);
    const fallback=defaults[type] as Record<string,unknown>;
    const value=parsed.success?parsed.data:fallback;
    // Legacy records had no activationVersion. They must fail closed.
    return [type,{...fallback,...value,enabled:value.activationVersion===3?value.enabled:false,activationVersion:3}];
  }));
}
