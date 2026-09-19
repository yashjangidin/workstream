import { z } from "zod";
export const timezone = z.string().refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid time zone.");
export const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(d => Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d);
export const schedule = z.object({
  timezone, requiredDailySeconds: z.number().int().min(60).max(86400),
  workdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).transform(v => [...new Set(v)]),
  idleThresholdSeconds: z.number().int().min(30).max(3600),
  autoStopIdleSeconds: z.number().int().min(60).max(86400).default(1800),
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
export const reportTypes=["DAILY_EMPLOYEE_REPORT","WEEKLY_EMPLOYEE_REPORT"] as const;
export const employeeReportTypes=reportTypes;
export const employerReportTypes=reportTypes;
export const alertRule = z.object({ enabled: z.boolean(), channels: z.array(z.literal("EMAIL")).length(1), cooldownSeconds: z.number().int().min(60).max(604800).optional(), thresholdSeconds: z.number().int().min(30).max(604800).optional(), trigger: z.record(z.any()).default({}), schedule: z.record(z.any()).optional(), recipient: z.string().max(254).default(""), activationVersion:z.literal(4).optional() });
export const alertSettings = z.record(z.enum(reportTypes), alertRule);
const report=(trigger:Record<string,unknown>)=>({enabled:true,activationVersion:4,channels:["EMAIL"] as const,trigger,recipient:""});
// These are the product's only notifications. The separate email channel must
// still be configured and enabled before any report can leave the system.
export const defaultEmployerAlerts={DAILY_EMPLOYEE_REPORT:report({time:"18:00",days:[0,1,2,3,4,5,6]}),WEEKLY_EMPLOYEE_REPORT:report({time:"09:00",day:"Monday"})};
export const defaultEmployeeAlerts={DAILY_EMPLOYEE_REPORT:report({time:"18:00",days:[0,1,2,3,4,5,6]}),WEEKLY_EMPLOYEE_REPORT:report({time:"09:00",day:"Monday"})};
export function sanitiseAlertSettings(raw:unknown,audience:"EMPLOYEE"|"EMPLOYER"){
  const parsed=alertSettings.parse(raw),employee=audience==="EMPLOYEE",types=employee?employeeReportTypes:employerReportTypes,fallback=(employee?defaultEmployeeAlerts:defaultEmployerAlerts) as Record<string,{channels:readonly ["EMAIL"]}>;
  return Object.fromEntries(types.map(type=>{const rule=parsed[type]??fallback[type];return [type,{...rule,channels:["EMAIL"],activationVersion:4}];}));
}
export function normaliseAlerts(raw:unknown,defaults:Record<string,unknown>,types:readonly string[]){
  const saved=(raw&&typeof raw==="object"?raw:{}) as Record<string,unknown>;
  return Object.fromEntries(types.map(type=>{
    const parsed=alertRule.safeParse(saved[type]);
    const fallback=defaults[type] as Record<string,unknown>;
    const value=parsed.success?parsed.data:fallback;
    const hasSaved=Object.prototype.hasOwnProperty.call(saved,type);
    // Missing and legacy report rules adopt the new email-report default. Once
    // saved at version 4, an employer can explicitly disable either schedule.
    const enabled=hasSaved?(parsed.success?value.enabled:fallback.enabled):fallback.enabled;
    return [type,{...fallback,...value,enabled,channels:["EMAIL"],activationVersion:4}];
  }));
}
