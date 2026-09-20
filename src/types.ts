export type EyeSide = "OD" | "OS";

/** 单眼试戴评估：矫正视力、适应时间、不适症状 */
export interface EyeTrialRecord {
  correctedVA: number;
  adaptMinutes: number;
  discomfort: string;
}

export type SessionStatus = "active" | "released" | "issued";

/** 一次试戴：占用一套试戴片的一个时段 */
export interface TrialSession {
  id: string;
  patientId: string;
  lensSetId: string;
  date: string; // YYYY-MM-DD
  start: string; // HH:MM
  end: string; // HH:MM
  pd: number; // 瞳距
  eyes: Record<EyeSide, EyeTrialRecord>;
  lowVAReason: string; // 矫正视力未达0.8的原因
  status: SessionStatus;
  createdAt: number;
  closedAt: number | null;
}

export interface RxEye {
  sph: number;
  cyl: number;
  axis: number;
  add: number;
}

export interface RxSnapshot {
  OD: RxEye;
  OS: RxEye;
  pd: number;
}

/** 处方版本：签发后冻结，复诊调整只能追加新版本 */
export interface RxVersion {
  version: number;
  source: "首次签发" | "复诊调整";
  reason: string;
  createdAt: number;
  rx: RxSnapshot;
}

export interface Prescription {
  id: string;
  patientId: string;
  sessionId: string;
  frozen: true;
  issuedAt: number;
  versions: RxVersion[];
}

export interface LensSet {
  id: string;
  code: string;
  label: string;
  rx: { OD: RxEye; OS: RxEye };
}

export interface Patient {
  id: string;
  name: string;
  tag: string;
}

/** 冲突记录：患者、试戴片、时段、触发规则 */
export interface ConflictEntry {
  id: string;
  at: number;
  patientName: string;
  lensSetCode: string;
  slot: string;
  rule: string;
  detail: string;
}

export interface AppState {
  patients: Patient[];
  lensSets: LensSet[];
  sessions: TrialSession[];
  prescriptions: Prescription[];
  conflicts: ConflictEntry[];
}
