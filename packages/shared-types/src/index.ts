export type MonitoringMode = "SIMPLE_TIMER" | "ACTIVE_MONITORING";
export type SessionStatus = "ACTIVE" | "COMPLETED" | "RECOVERED";
export type DeviceStatus = "ACTIVE" | "REVOKED" | "OFFLINE";
export type ProductivityClass = "PRODUCTIVE" | "NEUTRAL" | "NON_PRODUCTIVE";
export type AlertEventType = "EMPLOYEE_IDLE" | "EMPLOYEE_RETURNED" | "LATE_START" | "AGENT_OFFLINE" | "AGENT_STOPPED_REPORTING" | "NON_PRODUCTIVE_SUSTAINED" | "DAILY_TARGET_PROGRESS" | "DAILY_TARGET_MISSED" | "DAILY_REPORT" | "WEEKLY_REPORT";

export interface EmployeeSettings {
  timezone: string;
  requiredDailySeconds: number;
  workdays: number[];
  idleThresholdSeconds: number;
  officeStart?: string;
  officeEnd?: string;
  lateStartDelaySeconds: number;
  monitoringMode: MonitoringMode;
}

export interface WorkSession {
  id: string; companyId: string; employeeId: string; deviceId: string;
  startedAt: string; stoppedAt?: string; durationSeconds: number;
  idleDurationSeconds: number; effectiveDurationSeconds: number; status: SessionStatus;
}

export interface EmployeeCreateInput {
  fullName: string; email: string; timezone: string; requiredDailySeconds: number;
  workdays: number[]; idleThresholdSeconds: number; monitoringMode: MonitoringMode;
  phone?: string; designation?: string; department?: string; employeeCode?: string;
  officeStart?: string; officeEnd?: string; lateStartDelaySeconds?: number;
}

export interface SetupCodeCreated { employeeId: string; setupCode: string; invitationUrl: string; }
