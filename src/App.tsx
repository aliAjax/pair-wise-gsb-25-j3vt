import { useEffect, useMemo, useState } from "react";
import "./styles.css";

/* ================= 项目信息 ================= */

const project = {
  id: "hxwl-11",
  port: 5111,
  title: "眼科验光记录",
  subtitle:
    "试戴评估与处方签发闭环：每次试戴占用一套试戴片，按左右眼记录矫正视力、适应时间与不适症状；签发即冻结，复诊调整只能新建带原因版本。",
  stack: "React + Vite + TypeScript + CSS",
  domain: "眼视光",
  users: ["验光师", "门店顾问", "复查医生"],
};

/* ================= 业务规则（触发时原样展示在冲突面板） ================= */

const VA_THRESHOLD = 0.8;
const RULE_OCCUPY = "同一时段同一试戴片不得重复占用";
const RULE_LOW_VA = "任一眼矫正视力未达0.8必须填写原因";
const RULE_NO_ISSUE = "原因未填不得签发";
const RULE_NO_RELEASE = "原因未填不能释放占用";
const RULE_FROZEN = "签发后处方冻结，复诊调整只能新建带原因版本";
const RULE_COMPLETE = "矫正视力与适应时间须按左右眼记录完整";

/* ================= 领域模型 ================= */

type EyeSide = "OD" | "OS";

interface Patient {
  id: string;
  name: string;
  tag: string;
}

interface LensSet {
  id: string;
  code: string;
  name: string;
}

interface EyeEval {
  correctedVA: number | null; // 矫正视力（小数记录法）
  adaptMinutes: number | null; // 适应时间（分钟）
  discomfort: string[]; // 不适症状
}

interface EyeParams {
  sphere: string; // 球镜
  cylinder: string; // 柱镜
  axis: string; // 轴位
}

type SessionStatus = "occupied" | "released" | "issued";

interface TrialSession {
  id: string;
  patientId: string;
  lensSetId: string;
  date: string; // YYYY-MM-DD
  slot: string; // 时段，如 09:00-09:30
  eyes: Record<EyeSide, EyeEval>;
  params: Record<EyeSide, EyeParams>; // 试戴参数，签发时快照进处方
  lowVAReason: string; // 矫正视力低于0.8的原因
  status: SessionStatus; // occupied=占用中 released=已释放 issued=已签发(占用随之释放)
  createdAt: string;
  closedAt: string | null;
}

interface Prescription {
  id: string;
  chainId: string; // 修订链 id（首版的 chainId = 自身 id）
  version: number;
  parentId: string | null; // 上一版，构成修订链
  patientId: string;
  sessionId: string; // 来源试戴记录
  params: Record<EyeSide, EyeParams>;
  revisionReason: string; // 首版为“首次签发”，修订版必填调整原因
  issuedAt: string; // 签发即冻结，之后不可改
}

interface ConflictEvent {
  id: string;
  at: string;
  patient: string;
  lensSet: string;
  slot: string;
  rule: string; // 触发规则
  detail: string;
}

interface PersistedState {
  sessions: TrialSession[];
  prescriptions: Prescription[];
  conflicts: ConflictEvent[];
}

interface RevisionDraft {
  chainId: string;
  reason: string;
  params: Record<EyeSide, EyeParams>;
}

/* ================= 基础数据 ================= */

const PATIENTS: Patient[] = [
  { id: "p1", name: "林晓然", tag: "儿童近视" },
  { id: "p2", name: "周文斌", tag: "渐进片" },
  { id: "p3", name: "吴雨桐", tag: "散光复查" },
  { id: "p4", name: "郑凯文", tag: "角膜塑形镜" },
];

const LENS_SETS: LensSet[] = [
  { id: "ts1", code: "TS-01", name: "近视试戴组" },
  { id: "ts2", code: "TS-02", name: "渐进试戴组" },
  { id: "ts3", code: "TS-03", name: "散光试戴组" },
  { id: "ts4", code: "TS-04", name: "综合试戴组" },
];

const SLOTS = [
  "09:00-09:30",
  "09:30-10:00",
  "10:00-10:30",
  "10:30-11:00",
  "14:00-14:30",
  "14:30-15:00",
  "15:00-15:30",
  "15:30-16:00",
];

const VA_OPTIONS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2];
const SYMPTOMS = ["无不适", "头晕", "眼胀", "视物变形", "复视", "恶心"];

const EYES: { key: EyeSide; name: string; label: string }[] = [
  { key: "OD", name: "右眼", label: "右眼 OD" },
  { key: "OS", name: "左眼", label: "左眼 OS" },
];

const STATUS_LABEL: Record<SessionStatus, string> = {
  occupied: "占用中",
  released: "已释放",
  issued: "已签发",
};

/* ================= 工具函数 ================= */

const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function toDateStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function todayStr(): string {
  return toDateStr(new Date());
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

function atTime(dateStr: string, hhmm: string): string {
  return new Date(`${dateStr}T${hhmm}:00`).toISOString();
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const fmtVA = (v: number | null) => (v === null ? "未测" : v.toFixed(1));
const fmtAdapt = (v: number | null) => (v === null ? "未记" : `${v}分钟`);

const emptyEye = (): EyeEval => ({ correctedVA: null, adaptMinutes: null, discomfort: [] });
const emptyParams = (): EyeParams => ({ sphere: "", cylinder: "", axis: "" });

/** 选择“无不适”时清空其他症状，选择其他症状时移除“无不适” */
function toggleSymptom(list: string[], tag: string): string[] {
  if (tag === "无不适") return list.includes(tag) ? [] : ["无不适"];
  const rest = list.filter((t) => t !== "无不适");
  return rest.includes(tag) ? rest.filter((t) => t !== tag) : [...rest, tag];
}

/* ================= 规则判定 ================= */

function eyeIsLowVA(s: TrialSession, eye: EyeSide): boolean {
  const v = s.eyes[eye].correctedVA;
  return v !== null && v < VA_THRESHOLD;
}

function sessionNeedsReason(s: TrialSession): boolean {
  return EYES.some(({ key }) => eyeIsLowVA(s, key));
}

function lowVADesc(s: TrialSession): string {
  return EYES.filter(({ key }) => eyeIsLowVA(s, key))
    .map(({ key, label }) => `${label}矫正视力${fmtVA(s.eyes[key].correctedVA)}`)
    .join("，");
}

function missingFields(s: TrialSession): string[] {
  const miss: string[] = [];
  for (const { key, name } of EYES) {
    if (s.eyes[key].correctedVA === null) miss.push(`${name}矫正视力`);
    if (s.eyes[key].adaptMinutes === null) miss.push(`${name}适应时间`);
  }
  return miss;
}

/* ================= 持久化（刷新后记录、占用、签发与修订链保持一致） ================= */

const STORAGE_KEY = "hxwl-11-optometry-v1";

function seedState(): PersistedState {
  const today = todayStr();
  const yesterday = shiftDate(today, -1);

  // 已完成并签发 v1 的试戴（含低视力原因）
  const s1: TrialSession = {
    id: "seed-s1",
    patientId: "p1",
    lensSetId: "ts1",
    date: yesterday,
    slot: "09:00-09:30",
    eyes: {
      OD: { correctedVA: 1.0, adaptMinutes: 15, discomfort: ["无不适"] },
      OS: { correctedVA: 0.6, adaptMinutes: 25, discomfort: ["头晕", "眼胀"] },
    },
    params: {
      OD: { sphere: "-2.75", cylinder: "-0.50", axis: "180" },
      OS: { sphere: "-3.25", cylinder: "-0.75", axis: "175" },
    },
    lowVAReason: "左眼屈光参差，最佳矫正视力0.6，已转介眼底检查",
    status: "issued",
    createdAt: atTime(yesterday, "09:02"),
    closedAt: atTime(yesterday, "09:28"),
  };

  const rx1: Prescription = {
    id: "seed-rx1",
    chainId: "seed-rx1",
    version: 1,
    parentId: null,
    patientId: "p1",
    sessionId: "seed-s1",
    params: deepCopy(s1.params),
    revisionReason: "首次签发",
    issuedAt: atTime(yesterday, "09:28"),
  };

  // 今天占用中的试戴：右眼0.7低于0.8且原因未填，用于演示签发/释放拦截
  const s2: TrialSession = {
    id: "seed-s2",
    patientId: "p3",
    lensSetId: "ts3",
    date: today,
    slot: "10:00-10:30",
    eyes: {
      OD: { correctedVA: 0.7, adaptMinutes: 10, discomfort: ["眼胀"] },
      OS: { correctedVA: null, adaptMinutes: null, discomfort: [] },
    },
    params: {
      OD: { sphere: "-1.50", cylinder: "-1.25", axis: "90" },
      OS: { sphere: "-1.25", cylinder: "-1.00", axis: "85" },
    },
    lowVAReason: "",
    status: "occupied",
    createdAt: atTime(today, "10:02"),
    closedAt: null,
  };

  return { sessions: [s2, s1], prescriptions: [rx1], conflicts: [] };
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        Array.isArray(parsed.sessions) &&
        Array.isArray(parsed.prescriptions) &&
        Array.isArray(parsed.conflicts)
      ) {
        return parsed as PersistedState;
      }
    }
  } catch {
    // 本地数据损坏时回退到演示数据
  }
  return seedState();
}

/* ================= 展示组件 ================= */

const statusColors = ["status-ok", "status-watch", "status-danger"];

function MetricCard({ label, value, index }: { label: string; value: number; index: number }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={statusColors[index % statusColors.length]} />
    </article>
  );
}

function ParamsTable({ params }: { params: Record<EyeSide, EyeParams> }) {
  return (
    <table className="params-table">
      <thead>
        <tr>
          <th>眼别</th>
          <th>球镜</th>
          <th>柱镜</th>
          <th>轴位</th>
        </tr>
      </thead>
      <tbody>
        {EYES.map(({ key, label }) => (
          <tr key={key}>
            <td>{label}</td>
            <td>{params[key].sphere || "—"}</td>
            <td>{params[key].cylinder || "—"}</td>
            <td>{params[key].axis || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ParamsEditor({
  params,
  onChange,
}: {
  params: Record<EyeSide, EyeParams>;
  onChange: (eye: EyeSide, patch: Partial<EyeParams>) => void;
}) {
  return (
    <div className="eye-grid">
      {EYES.map(({ key, label }) => (
        <div className="eye-box" key={key}>
          <h4>{label}</h4>
          <div className="params-row">
            <label>
              <span>球镜</span>
              <input value={params[key].sphere} placeholder="-2.75" onChange={(e) => onChange(key, { sphere: e.target.value })} />
            </label>
            <label>
              <span>柱镜</span>
              <input value={params[key].cylinder} placeholder="-0.50" onChange={(e) => onChange(key, { cylinder: e.target.value })} />
            </label>
            <label>
              <span>轴位</span>
              <input value={params[key].axis} placeholder="180" onChange={(e) => onChange(key, { axis: e.target.value })} />
            </label>
          </div>
        </div>
      ))}
    </div>
  );
}

interface SessionCardProps {
  session: TrialSession;
  patientLabel: string;
  lensLabel: string;
  onPatchEye: (id: string, eye: EyeSide, patch: Partial<EyeEval>) => void;
  onPatchParams: (id: string, eye: EyeSide, patch: Partial<EyeParams>) => void;
  onReason: (id: string, reason: string) => void;
  onRelease: (s: TrialSession) => void;
  onIssue: (s: TrialSession) => void;
}

function SessionCard({ session: s, patientLabel, lensLabel, onPatchEye, onPatchParams, onReason, onRelease, onIssue }: SessionCardProps) {
  const needsReason = sessionNeedsReason(s);
  return (
    <article className="session-card">
      <header>
        <div>
          <strong>{patientLabel}</strong>
          <span className="session-meta">
            {lensLabel} · {s.date} {s.slot} · 开始于 {fmtTime(s.createdAt)}
          </span>
        </div>
        <span className="badge badge-occupied">占用中</span>
      </header>

      <div className="eye-grid">
        {EYES.map(({ key, label }) => {
          const eye = s.eyes[key];
          const low = eyeIsLowVA(s, key);
          return (
            <div className="eye-box" key={key}>
              <h4>{label}</h4>
              <label>
                <span className={low ? "low-va" : ""}>矫正视力{low ? "（低于0.8，须填原因）" : ""}</span>
                <select
                  value={eye.correctedVA === null ? "" : String(eye.correctedVA)}
                  onChange={(e) => onPatchEye(s.id, key, { correctedVA: e.target.value === "" ? null : parseFloat(e.target.value) })}
                >
                  <option value="">未测</option>
                  {VA_OPTIONS.map((v) => (
                    <option key={v} value={String(v)}>
                      {v.toFixed(1)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>适应时间（分钟）</span>
                <input
                  type="number"
                  min={0}
                  placeholder="如 15"
                  value={eye.adaptMinutes === null ? "" : eye.adaptMinutes}
                  onChange={(e) =>
                    onPatchEye(s.id, key, { adaptMinutes: e.target.value === "" ? null : Math.max(0, parseInt(e.target.value, 10) || 0) })
                  }
                />
              </label>
              <div className="symptoms">
                <span>不适症状</span>
                <div className="chips">
                  {SYMPTOMS.map((tag) => (
                    <button
                      key={tag}
                      className={eye.discomfort.includes(tag) ? "active" : ""}
                      onClick={() => onPatchEye(s.id, key, { discomfort: toggleSymptom(eye.discomfort, tag) })}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
              <div className="params-row">
                <label>
                  <span>球镜</span>
                  <input value={s.params[key].sphere} placeholder="-2.75" onChange={(e) => onPatchParams(s.id, key, { sphere: e.target.value })} />
                </label>
                <label>
                  <span>柱镜</span>
                  <input value={s.params[key].cylinder} placeholder="-0.50" onChange={(e) => onPatchParams(s.id, key, { cylinder: e.target.value })} />
                </label>
                <label>
                  <span>轴位</span>
                  <input value={s.params[key].axis} placeholder="180" onChange={(e) => onPatchParams(s.id, key, { axis: e.target.value })} />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <label className={"reason-box" + (needsReason ? " reason-required" : "")}>
        <span>
          矫正视力低于{VA_THRESHOLD.toFixed(1)}原因
          {needsReason ? `（必填：${lowVADesc(s)}，未填不得签发/释放）` : "（任一眼低于0.8时必填）"}
        </span>
        <textarea
          rows={2}
          value={s.lowVAReason}
          placeholder="如：弱视、屈光参差、配合度差，已建议进一步检查……"
          onChange={(e) => onReason(s.id, e.target.value)}
        />
      </label>

      <div className="actions-row">
        <button onClick={() => onRelease(s)}>结束试戴并释放占用</button>
        <button className="primary-action" onClick={() => onIssue(s)}>
          签发处方（签发后冻结）
        </button>
      </div>
    </article>
  );
}

/* ================= 主应用 ================= */

function App() {
  const [state, setState] = useState<PersistedState>(loadState);
  const { sessions, prescriptions, conflicts } = state;

  // 新建试戴的选择项
  const [patientId, setPatientId] = useState(PATIENTS[0].id);
  const [lensSetId, setLensSetId] = useState(LENS_SETS[0].id);
  const [date, setDate] = useState(todayStr());
  const [slot, setSlot] = useState(SLOTS[0]);

  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState<RevisionDraft | null>(null);

  // 任何状态变化都落盘，保证刷新后记录、占用、签发与修订链一致
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const patientName = (id: string) => PATIENTS.find((p) => p.id === id)?.name ?? id;
  const lensCode = (id: string) => LENS_SETS.find((l) => l.id === id)?.code ?? id;
  const lensName = (id: string) => LENS_SETS.find((l) => l.id === id)?.name ?? id;

  const occupiedList = sessions.filter((s) => s.status === "occupied");
  const clashFor = (lensId: string, d: string, sl: string) =>
    sessions.find((s) => s.lensSetId === lensId && s.date === d && s.slot === sl && s.status === "occupied");

  const chains = useMemo(() => {
    const map = new Map<string, Prescription[]>();
    for (const p of prescriptions) {
      const list = map.get(p.chainId) ?? [];
      list.push(p);
      map.set(p.chainId, list);
    }
    return [...map.values()]
      .map((list) => [...list].sort((a, b) => b.version - a.version))
      .sort((a, b) => b[0].issuedAt.localeCompare(a[0].issuedAt));
  }, [prescriptions]);

  /* ---------- 状态修改辅助 ---------- */

  function pushConflict(c: Omit<ConflictEvent, "id" | "at">) {
    setState((prev) => ({ ...prev, conflicts: [{ ...c, id: uid(), at: new Date().toISOString() }, ...prev.conflicts] }));
    setNotice("");
  }

  function patchSession(id: string, patch: Partial<TrialSession>) {
    setState((prev) => ({ ...prev, sessions: prev.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  }

  function patchEye(id: string, eye: EyeSide, patch: Partial<EyeEval>) {
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) => (s.id === id ? { ...s, eyes: { ...s.eyes, [eye]: { ...s.eyes[eye], ...patch } } } : s)),
    }));
  }

  function patchParams(id: string, eye: EyeSide, patch: Partial<EyeParams>) {
    setState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) => (s.id === id ? { ...s, params: { ...s.params, [eye]: { ...s.params[eye], ...patch } } } : s)),
    }));
  }

  /* ---------- 闭环动作 ---------- */

  // 开始试戴：占用一套试戴片；同时段同试戴片冲突则拦截并记录
  function startTrial() {
    if (!date || !slot) {
      setNotice("请选择日期与时段。");
      return;
    }
    const clash = clashFor(lensSetId, date, slot);
    if (clash) {
      pushConflict({
        patient: `${patientName(patientId)}（占用者：${patientName(clash.patientId)}）`,
        lensSet: lensCode(lensSetId),
        slot: `${date} ${slot}`,
        rule: RULE_OCCUPY,
        detail: `${lensCode(lensSetId)} ${lensName(lensSetId)}在 ${date} ${slot} 已由 ${patientName(clash.patientId)} 占用，${patientName(patientId)} 的试戴未创建。`,
      });
      return;
    }
    const session: TrialSession = {
      id: uid(),
      patientId,
      lensSetId,
      date,
      slot,
      eyes: { OD: emptyEye(), OS: emptyEye() },
      params: { OD: emptyParams(), OS: emptyParams() },
      lowVAReason: "",
      status: "occupied",
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    setState((prev) => ({ ...prev, sessions: [session, ...prev.sessions] }));
    setNotice(`已开始试戴：${patientName(patientId)} 占用 ${lensCode(lensSetId)}（${date} ${slot}），请按左右眼完成评估。`);
  }

  // 释放占用：任一眼低于0.8且原因未填时拦截
  function releaseSession(s: TrialSession) {
    if (sessionNeedsReason(s) && !s.lowVAReason.trim()) {
      pushConflict({
        patient: patientName(s.patientId),
        lensSet: lensCode(s.lensSetId),
        slot: `${s.date} ${s.slot}`,
        rule: `${RULE_LOW_VA}；${RULE_NO_RELEASE}`,
        detail: `${lowVADesc(s)}，请先在试戴记录中填写原因，再释放 ${lensCode(s.lensSetId)}。`,
      });
      return;
    }
    patchSession(s.id, { status: "released", closedAt: new Date().toISOString() });
    setNotice(`已释放 ${lensCode(s.lensSetId)}（${patientName(s.patientId)} · ${s.date} ${s.slot}），该时段可再次占用。`);
  }

  // 签发处方：校验双眼记录完整 + 低视力原因；签发后处方冻结、占用释放
  function issuePrescription(s: TrialSession) {
    const miss = missingFields(s);
    if (miss.length > 0) {
      pushConflict({
        patient: patientName(s.patientId),
        lensSet: lensCode(s.lensSetId),
        slot: `${s.date} ${s.slot}`,
        rule: RULE_COMPLETE,
        detail: `缺少：${miss.join("、")}，请补全后再签发。`,
      });
      return;
    }
    if (sessionNeedsReason(s) && !s.lowVAReason.trim()) {
      pushConflict({
        patient: patientName(s.patientId),
        lensSet: lensCode(s.lensSetId),
        slot: `${s.date} ${s.slot}`,
        rule: `${RULE_LOW_VA}；${RULE_NO_ISSUE}`,
        detail: `${lowVADesc(s)}，原因未填写，本次签发被拦截。`,
      });
      return;
    }
    const id = uid();
    const rx: Prescription = {
      id,
      chainId: id,
      version: 1,
      parentId: null,
      patientId: s.patientId,
      sessionId: s.id,
      params: deepCopy(s.params),
      revisionReason: "首次签发",
      issuedAt: new Date().toISOString(),
    };
    setState((prev) => ({
      ...prev,
      prescriptions: [rx, ...prev.prescriptions],
      sessions: prev.sessions.map((x) => (x.id === s.id ? { ...x, status: "issued", closedAt: new Date().toISOString() } : x)),
    }));
    setNotice(`已签发 ${patientName(s.patientId)} 的处方 v1（冻结），${lensCode(s.lensSetId)} 占用已释放。`);
  }

  // 复诊调整：只能基于冻结处方新建带原因版本，旧版本保留在修订链
  function submitRevision(chain: Prescription[]) {
    const latest = chain[0];
    if (!revision || revision.chainId !== latest.chainId) return;
    if (!revision.reason.trim()) {
      pushConflict({
        patient: patientName(latest.patientId),
        lensSet: "—",
        slot: "—",
        rule: RULE_FROZEN,
        detail: `v${latest.version} 已冻结不可修改，新建 v${latest.version + 1} 必须填写修订原因。`,
      });
      return;
    }
    const rx: Prescription = {
      id: uid(),
      chainId: latest.chainId,
      version: latest.version + 1,
      parentId: latest.id,
      patientId: latest.patientId,
      sessionId: latest.sessionId,
      params: deepCopy(revision.params),
      revisionReason: revision.reason.trim(),
      issuedAt: new Date().toISOString(),
    };
    setState((prev) => ({ ...prev, prescriptions: [rx, ...prev.prescriptions] }));
    setRevision(null);
    setNotice(`已签发 ${patientName(latest.patientId)} 的修订版 v${rx.version}（冻结），修订链现有 ${chain.length + 1} 版。`);
  }

  function resetAll() {
    if (!window.confirm("清空本地数据并恢复演示数据？")) return;
    setState(seedState());
    setRevision(null);
    setNotice("已重置为演示数据。");
  }

  /* ---------- 渲染 ---------- */

  const today = todayStr();
  const metrics = [
    { label: "今日试戴", value: sessions.filter((s) => s.date === today).length },
    { label: "占用中试戴片", value: new Set(occupiedList.map((s) => s.lensSetId)).size },
    { label: "已签发处方", value: prescriptions.length },
    { label: "待补低视力原因", value: occupiedList.filter((s) => sessionNeedsReason(s) && !s.lowVAReason.trim()).length },
  ];

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">
            {project.id} · port {project.port}
          </p>
          <h1>{project.title}</h1>
          <p className="subtitle">{project.subtitle}</p>
        </div>
        <div className="stack-card">
          <span>技术栈</span>
          <strong>{project.stack}</strong>
          <span>适用角色</span>
          <strong>{project.users.join(" · ")}</strong>
        </div>
      </section>

      {notice && <div className="notice">{notice}</div>}

      <section className="metrics-grid">
        {metrics.map((m, index) => (
          <MetricCard key={m.label} label={m.label} value={m.value} index={index} />
        ))}
      </section>

      <section className="workspace">
        <aside className="panel narrow">
          <h2>患者</h2>
          <div className="chips select-chips">
            {PATIENTS.map((p) => (
              <button key={p.id} className={p.id === patientId ? "active" : ""} onClick={() => setPatientId(p.id)}>
                {p.name}
                <small>{p.tag}</small>
              </button>
            ))}
          </div>

          <h2>试戴片</h2>
          <div className="lens-list">
            {LENS_SETS.map((l) => {
              const occ = occupiedList.find((s) => s.lensSetId === l.id);
              return (
                <button key={l.id} className={"lens-row" + (l.id === lensSetId ? " active" : "")} onClick={() => setLensSetId(l.id)}>
                  <span>
                    <strong>{l.code}</strong> {l.name}
                  </span>
                  {occ ? (
                    <em className="badge badge-occupied" title={`${patientName(occ.patientId)} · ${occ.date} ${occ.slot}`}>
                      占用中
                    </em>
                  ) : (
                    <em className="badge badge-free">空闲</em>
                  )}
                </button>
              );
            })}
          </div>

          <h2>日期与时段</h2>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <div className="chips slot-chips">
            {SLOTS.map((sl) => {
              const clash = clashFor(lensSetId, date, sl);
              return (
                <button
                  key={sl}
                  className={(sl === slot ? "active " : "") + (clash ? "slot-busy" : "")}
                  title={clash ? `已被 ${patientName(clash.patientId)} 占用，点击开始将触发占用冲突` : ""}
                  onClick={() => setSlot(sl)}
                >
                  {sl}
                  {clash ? " · 占" : ""}
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>{project.domain} · 试戴闭环</p>
              <h2>新建试戴（占用试戴片）</h2>
            </div>
            <button className="primary-action" onClick={startTrial}>
              开始试戴并占用
            </button>
          </div>
          <p className="selection-summary">
            当前选择：{patientName(patientId)} · {lensCode(lensSetId)} {lensName(lensSetId)} · {date} {slot}
          </p>
          <div className="rule-hints">
            <span>· {RULE_OCCUPY}</span>
            <span>· {RULE_LOW_VA}</span>
            <span>· {RULE_NO_ISSUE}，{RULE_NO_RELEASE}</span>
            <span>· {RULE_FROZEN}</span>
          </div>

          <h3 className="sub-heading">试戴评估（占用中 {occupiedList.length}）</h3>
          {occupiedList.length === 0 && <p className="empty">当前没有占用中的试戴。选择患者、试戴片与时段后点击“开始试戴并占用”。</p>}
          {occupiedList.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              patientLabel={patientName(s.patientId)}
              lensLabel={`${lensCode(s.lensSetId)} ${lensName(s.lensSetId)}`}
              onPatchEye={patchEye}
              onPatchParams={patchParams}
              onReason={(id, reason) => patchSession(id, { lowVAReason: reason })}
              onRelease={releaseSession}
              onIssue={issuePrescription}
            />
          ))}
        </section>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>签发即冻结 · 调整走修订链</p>
            <h2>处方签发与修订链</h2>
          </div>
        </div>
        {chains.length === 0 && <p className="empty">尚未签发处方。完成试戴评估后在上方签发。</p>}
        {chains.map((chain) => {
          const latest = chain[0];
          const history = chain.slice(1);
          const editing = revision?.chainId === latest.chainId;
          return (
            <article className="rx-card" key={latest.chainId}>
              <header>
                <div>
                  <strong>{patientName(latest.patientId)}</strong>
                  <span className="session-meta">
                    当前 v{latest.version} · 共 {chain.length} 版
                  </span>
                </div>
                <span className="badge badge-frozen">已冻结</span>
              </header>
              <ParamsTable params={latest.params} />
              <p className="rx-meta">
                v{latest.version} 签发 {fmtTime(latest.issuedAt)} · 原因：{latest.revisionReason}
              </p>
              {history.map((h) => (
                <div className="rx-history" key={h.id}>
                  <span className="badge badge-history">v{h.version} 历史版本</span>
                  <span>
                    签发 {fmtTime(h.issuedAt)} · 原因：{h.revisionReason}
                  </span>
                  <ParamsTable params={h.params} />
                </div>
              ))}
              {!editing ? (
                <div className="actions-row">
                  <button onClick={() => setRevision({ chainId: latest.chainId, reason: "", params: deepCopy(latest.params) })}>
                    复诊调整 · 新建带原因版本
                  </button>
                </div>
              ) : (
                <div className="inline-form">
                  <h4>
                    新建 v{latest.version + 1}（签发后冻结，v{latest.version} 保留在修订链）
                  </h4>
                  <ParamsEditor
                    params={revision.params}
                    onChange={(eye, patch) =>
                      setRevision((prev) => (prev ? { ...prev, params: { ...prev.params, [eye]: { ...prev.params[eye], ...patch } } } : prev))
                    }
                  />
                  <label className="reason-box reason-required">
                    <span>修订原因（必填，说明本次复诊调整依据）</span>
                    <textarea
                      rows={2}
                      value={revision.reason}
                      placeholder="如：复诊度数变化 -0.25D，重新验配"
                      onChange={(e) => setRevision((prev) => (prev ? { ...prev, reason: e.target.value } : prev))}
                    />
                  </label>
                  <div className="actions-row">
                    <button className="primary-action" onClick={() => submitRevision(chain)}>
                      签发新版本 v{latest.version + 1}
                    </button>
                    <button onClick={() => setRevision(null)}>取消</button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>规则引擎</p>
            <h2>冲突与触发规则</h2>
          </div>
          {conflicts.length > 0 && <button onClick={() => setState((prev) => ({ ...prev, conflicts: [] }))}>清空冲突记录</button>}
        </div>
        {conflicts.length === 0 ? (
          <p className="empty">暂无冲突。重复占用同时段试戴片、低视力原因缺失时，将在此列出患者、试戴片、时段与触发规则。</p>
        ) : (
          <div className="conflict-list">
            {conflicts.map((c) => (
              <article className="conflict-row" key={c.id}>
                <span className="conflict-time">{fmtTime(c.at)}</span>
                <span>
                  <em>患者</em>
                  {c.patient}
                </span>
                <span>
                  <em>试戴片</em>
                  {c.lensSet}
                </span>
                <span>
                  <em>时段</em>
                  {c.slot}
                </span>
                <span className="conflict-rule">
                  <em>触发规则</em>
                  {c.rule}
                </span>
                <p>{c.detail}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="records panel">
        <div className="section-heading">
          <div>
            <p>持久化 · 刷新后记录 / 占用 / 签发 / 修订链一致</p>
            <h2>全部试戴记录</h2>
          </div>
          <button onClick={resetAll}>重置演示数据</button>
        </div>
        <div className="record-list">
          {sessions.map((s, index) => (
            <article key={s.id} className="record-card">
              <div className="record-index">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <h3>
                  {patientName(s.patientId)} <span className={`badge badge-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                </h3>
                <p>
                  {lensCode(s.lensSetId)} {lensName(s.lensSetId)} · {s.date} {s.slot} · 右眼 {fmtVA(s.eyes.OD.correctedVA)}（适应
                  {fmtAdapt(s.eyes.OD.adaptMinutes)}）· 左眼 {fmtVA(s.eyes.OS.correctedVA)}（适应{fmtAdapt(s.eyes.OS.adaptMinutes)}） ·{" "}
                  {s.lowVAReason
                    ? `低视力原因：${s.lowVAReason}`
                    : sessionNeedsReason(s)
                      ? "⚠ 矫正视力低于0.8，原因未填"
                      : "矫正视力均达标"}
                  {s.closedAt ? ` · 结束于 ${fmtTime(s.closedAt)}` : ""}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
