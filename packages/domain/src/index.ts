import type { ProductivityClass } from "@workstream/shared-types";
export * from "./operations.js";

export interface Interval { startedAt: Date; endedAt: Date; }
export interface TimeTotals { timerSeconds: number; idleSeconds: number; effectiveSeconds: number; }

const seconds = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));

/** Canonical TIME calculation. Productivity is intentionally absent. */
export function calculateTimeTotals(session: Interval, idleIntervals: Interval[]): TimeTotals {
  const timerSeconds = seconds(session.startedAt, session.endedAt);
  const clipped = idleIntervals.map(({ startedAt, endedAt }) => ({
    startedAt: new Date(Math.max(startedAt.getTime(), session.startedAt.getTime())),
    endedAt: new Date(Math.min(endedAt.getTime(), session.endedAt.getTime()))
  })).filter(i => i.endedAt > i.startedAt).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const merged: Interval[] = [];
  for (const current of clipped) {
    const last = merged.at(-1);
    if (last && current.startedAt <= last.endedAt) last.endedAt = new Date(Math.max(last.endedAt.getTime(), current.endedAt.getTime()));
    else merged.push(current);
  }
  const idleSeconds = merged.reduce((sum, interval) => sum + seconds(interval.startedAt, interval.endedAt), 0);
  return { timerSeconds, idleSeconds, effectiveSeconds: Math.max(0, timerSeconds - idleSeconds) };
}

export function classifyActivity(value: string, rules: Array<{ pattern: string; classification: ProductivityClass; enabled: boolean }>): ProductivityClass {
  const normalized = value.trim().toLowerCase().replace(/^www\./, "");
  return rules.find(rule => rule.enabled && normalized === rule.pattern.trim().toLowerCase().replace(/^www\./, ""))?.classification ?? "NEUTRAL";
}

export function monitoringAllowed(timerIsActive: boolean, mode: "SIMPLE_TIMER" | "ACTIVE_MONITORING") {
  return timerIsActive && mode === "ACTIVE_MONITORING";
}

export function alertDedupeKey(employeeId: string, type: string, period: string, threshold: string) {
  return `${employeeId}:${type}:${period}:${threshold}`;
}
