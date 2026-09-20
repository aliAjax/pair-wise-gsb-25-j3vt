import type {
  AppState,
  ConflictEntry,
  LensSet,
  Patient,
  Prescription,
  TrialSession,
} from "./types";

export const STORAGE_KEY = "hxwl-11-trial-rx-v1";

/** 业务规则 */
export const RULES = {
  R1: "R1 · 同一时段同一试戴片不得重复占用",
  R2: "R2 · 同一患者同一时段不得重复试戴",
  R3: "R3 · 任一眼矫正视力未达0.8必须填写原因，原因未填不得签发也不得释放占用",
  R4: "R4 · 签发后处方冻结，复诊调整只能新建带原因版本",
} as const;

export const LOW_VA = 0.8;

export const VA_OPTIONS = [
  "0.1", "0.12", "0.15", "0.2", "0.25", "0.3",
  "0.4", "0.5", "0.6", "0.8", "1.0", "1.2", "1.5", "2.0",
];

export const DISCOMFORT_OPTIONS = ["无", "头晕", "眼胀", "视疲劳", "视物变形", "恶心", "重影"];

/* ---------- 工具 ---------- */

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function slotLabel(s: { date: string; start: string; end: string }): string {
  return `${s.date} ${s.start}–${s.end}`;
}

export function fmtD(n: number): string {
  return (n > 0 ? "+" : "") + n.toFixed(2);
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ---------- 规则判定 ---------- */

export function needsReason(s: TrialSession): boolean {
  return s.eyes.OD.correctedVA < LOW_VA || s.eyes.OS.correctedVA < LOW_VA;
}

export function reasonMissing(s: TrialSession): boolean {
  return needsReason(s) && s.lowVAReason.trim() === "";
}

export interface ConflictHit {
  rule: string;
  withSession: TrialSession;
}

/** 占用冲突检测：同一时段同一试戴片 / 同一患者 */
export function findConflicts(
  state: AppState,
  candidate: { patientId: string; lensSetId: string; date: string; start: string; end: string },
): ConflictHit[] {
  const s = toMinutes(candidate.start);
  const e = toMinutes(candidate.end);
  const hits: ConflictHit[] = [];
  for (const sess of state.sessions) {
    if (sess.status !== "active" || sess.date !== candidate.date) continue;
    if (!rangesOverlap(s, e, toMinutes(sess.start), toMinutes(sess.end))) continue;
    if (sess.lensSetId === candidate.lensSetId) {
      hits.push({ rule: RULES.R1, withSession: sess });
    } else if (sess.patientId === candidate.patientId) {
      hits.push({ rule: RULES.R2, withSession: sess });
    }
  }
  return hits;
}

/* ---------- 种子数据 ---------- */

function seedState(): AppState {
  const now = Date.now();
  const today = todayStr();
  const yesterdayDate = new Date(now - 86400000);
  const yesterday = `${yesterdayDate.getFullYear()}-${pad2(yesterdayDate.getMonth() + 1)}-${pad2(yesterdayDate.getDate())}`;

  const patients: Patient[] = [
    { id: "P-032", name: "林小满", tag: "儿童近视 · 复查" },
    { id: "P-081", name: "周慧兰", tag: "渐进片 · 初配" },
    { id: "P-144", name: "陈立", tag: "散光 · 复查" },
    { id: "P-207", name: "王可", tag: "青少年 · 初配" },
  ];

  const lensSets: LensSet[] = [
    {
      id: "LS-1",
      code: "TL-01",
      label: "OU -1.50DS 低度近视",
      rx: {
        OD: { sph: -1.5, cyl: 0, axis: 0, add: 0 },
        OS: { sph: -1.5, cyl: 0, axis: 0, add: 0 },
      },
    },
    {
      id: "LS-2",
      code: "TL-02",
      label: "OD -2.75 / OS -3.00 儿童复查",
      rx: {
        OD: { sph: -2.75, cyl: 0, axis: 0, add: 0 },
        OS: { sph: -3.0, cyl: 0, axis: 0, add: 0 },
      },
    },
    {
      id: "LS-3",
      code: "TL-03",
      label: "OU +1.00 ADD +1.50 渐进体验",
      rx: {
        OD: { sph: 1.0, cyl: 0, axis: 0, add: 1.5 },
        OS: { sph: 1.0, cyl: 0, axis: 0, add: 1.5 },
      },
    },
    {
      id: "LS-4",
      code: "TL-04",
      label: "OD -1.25/-0.50×180 散光",
      rx: {
        OD: { sph: -1.25, cyl: -0.5, axis: 180, add: 0 },
        OS: { sph: -1.0, cyl: -0.25, axis: 175, add: 0 },
      },
    },
  ];

  // 进行中的试戴：左眼矫正视力0.6 < 0.8，原因未填 → 演示签发/释放拦截
  const activeSession: TrialSession = {
    id: "S-seed-1",
    patientId: "P-032",
    lensSetId: "LS-2",
    date: today,
    start: "09:00",
    end: "09:40",
    pd: 58,
    eyes: {
      OD: { correctedVA: 1.0, adaptMinutes: 15, discomfort: "无" },
      OS: { correctedVA: 0.6, adaptMinutes: 25, discomfort: "头晕" },
    },
    lowVAReason: "",
    status: "active",
    createdAt: now - 3600000,
    closedAt: null,
  };

  // 已签发的试戴：处方冻结，含一条复诊调整版本 → 演示修订链
  const issuedSession: TrialSession = {
    id: "S-seed-2",
    patientId: "P-081",
    lensSetId: "LS-3",
    date: yesterday,
    start: "14:00",
    end: "14:40",
    pd: 63,
    eyes: {
      OD: { correctedVA: 1.0, adaptMinutes: 20, discomfort: "无" },
      OS: { correctedVA: 1.0, adaptMinutes: 20, discomfort: "视疲劳" },
    },
    lowVAReason: "",
    status: "issued",
    createdAt: now - 90000000,
    closedAt: now - 89000000,
  };

  const prescription: Prescription = {
    id: "RX-seed-1",
    patientId: "P-081",
    sessionId: "S-seed-2",
    frozen: true,
    issuedAt: now - 89000000,
    versions: [
      {
        version: 2,
        source: "复诊调整",
        reason: "看近疲劳，下加光 +0.25D",
        createdAt: now - 43200000,
        rx: {
          OD: { sph: 1.0, cyl: 0, axis: 0, add: 1.75 },
          OS: { sph: 1.0, cyl: 0, axis: 0, add: 1.75 },
          pd: 63,
        },
      },
      {
        version: 1,
        source: "首次签发",
        reason: "首次签发，试戴评估通过",
        createdAt: now - 89000000,
        rx: {
          OD: { sph: 1.0, cyl: 0, axis: 0, add: 1.5 },
          OS: { sph: 1.0, cyl: 0, axis: 0, add: 1.5 },
          pd: 63,
        },
      },
    ],
  };

  return {
    patients,
    lensSets,
    sessions: [activeSession, issuedSession],
    prescriptions: [prescription],
    conflicts: [],
  };
}

/* ---------- 持久化：刷新后记录、占用、签发、修订链一致 ---------- */

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed && Array.isArray(parsed.sessions) && Array.isArray(parsed.prescriptions)) {
        return parsed;
      }
    }
  } catch {
    // 数据损坏时回退到种子数据
  }
  return seedState();
}

export function saveState(state: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetState(): AppState {
  localStorage.removeItem(STORAGE_KEY);
  return seedState();
}

export type { AppState, ConflictEntry };
