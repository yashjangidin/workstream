import { calculateTimeTotals, type Interval } from "./index.js";

export const milliseconds = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  if (value && typeof value === "object" && "toMillis" in value) return (value as { toMillis(): number }).toMillis();
  return NaN;
};
export function localDate(at: number, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
export function nextDate(date: string, days = 1) { return new Date(Date.parse(date + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10); }
/** Find local midnight using date comparisons, including DST and non-hour offsets. */
export function dayBounds(date: string, timezone: string) {
  const midnight = (d: string) => {
    let lo = Date.parse(d + "T00:00:00Z") - 36 * 3600000;
    let hi = lo + 72 * 3600000;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (localDate(mid, timezone) < d) lo = mid; else hi = mid; }
    return hi;
  };
  return { start: midnight(date), end: midnight(nextDate(date)) };
}
export type RecordedSession = { startedAt: unknown; stoppedAt?: unknown; id: string; status: string; deviceId: string };
export type RecordedIdle = { startedAt: unknown; endedAt?: unknown; sessionId: string };
export function dailyTime(sessions: RecordedSession[], idle: RecordedIdle[], start: number, end: number, now: number) {
  const ranges: Interval[] = [], idleRanges: Interval[] = [];
  for (const session of sessions) {
    const from = Math.max(start, milliseconds(session.startedAt));
    const to = Math.min(end, now, session.stoppedAt ? milliseconds(session.stoppedAt) : now);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    ranges.push({startedAt:new Date(from),endedAt:new Date(to)});
    for(const i of idle.filter(i=>i.sessionId===session.id)) {
      const a=Math.max(from,milliseconds(i.startedAt)), b=Math.min(to,i.endedAt ? milliseconds(i.endedAt):to);
      if(Number.isFinite(a)&&Number.isFinite(b)&&b>a) idleRanges.push({startedAt:new Date(a),endedAt:new Date(b)});
    }
  }
  const duration=(items:Interval[])=>{
    let total=0,until=-Infinity;
    for(const item of items.sort((a,b)=>+a.startedAt-+b.startedAt)) {
      const from=Math.max(until,+item.startedAt),to=+item.endedAt!;
      if(to>from)total+=to-from;
      until=Math.max(until,to);
    }
    return Math.floor(total/1000);
  };
  const timerSeconds=duration(ranges),idleSeconds=Math.min(timerSeconds,duration(idleRanges));
  return {timerSeconds,idleSeconds,effectiveSeconds:timerSeconds-idleSeconds};
}
export function operationalStatus(device: { status: string; lastHeartbeatAt?: unknown } | undefined, running: boolean, idle: boolean, now: number, timeout: number) {
  const deviceStatus = !device ? "NOT_PAIRED" : device.status === "REVOKED" ? "REVOKED" : now - milliseconds(device.lastHeartbeatAt) <= timeout * 1000 ? "ONLINE" : "OFFLINE";
  return { deviceStatus, timerStatus: running ? "RUNNING" : "STOPPED", workStatus: deviceStatus === "OFFLINE" ? "OFFLINE" : running && deviceStatus === "ONLINE" ? idle ? "IDLE" : "WORKING" : "NOT_WORKING" };
}
export function targetStatus(timer: number, effective: number, required: number, end: number, now: number) { return effective >= required ? "COMPLETED" : now >= end ? "MISSED" : timer > 0 ? "IN_PROGRESS" : "NOT_STARTED"; }
export type Rule = { target: "APPLICATION" | "DOMAIN"; pattern: string; classification: "PRODUCTIVE" | "NEUTRAL" | "NON_PRODUCTIVE"; enabled: boolean; employeeId?: string | null; scope?: string };
export function normalizeDomain(value: string) { try { return new URL(value.includes("://") ? value : "https://" + value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } }
export function classify(rules: Rule[], employeeId: string, application: string, domain?: string) {
  const candidates = rules.filter(r => r.enabled && (!r.employeeId || r.employeeId === employeeId));
  candidates.sort((a,b) => (a.employeeId ? 0 : a.scope === "DEFAULT" ? 2 : 1) - (b.employeeId ? 0 : b.scope === "DEFAULT" ? 2 : 1));
  return candidates.find(r => r.target === "DOMAIN" ? domain && normalizeDomain(domain) === normalizeDomain(r.pattern) : application.toLowerCase() === r.pattern.toLowerCase())?.classification ?? "NEUTRAL";
}
