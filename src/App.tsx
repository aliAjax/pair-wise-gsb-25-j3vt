import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import type {
  AppState,
  ConflictEntry,
  EyeSide,
  LensSet,
  Patient,
  Prescription,
  RxSnapshot,
  TrialSession,
} from "./types";
import {
  DISCOMFORT_OPTIONS,
  LOW_VA,
  RULES,
  VA_OPTIONS,
  findConflicts,
  fmtD,
  fmtDateTime,
  loadState,
  needsReason,
  reasonMissing,
  resetState,
  saveState,
  slotLabel,
  toMinutes,
  todayStr,
  uid,
} from "./store";

type Notice = { kind: "error" | "ok"; text: string } | null;

const EYE_LABEL: Record<EyeSide, string> = { OD: "右眼 OD", OS: "左眼 OS" };

const STATUS_META: Record<TrialSession["status"], { label: string; cls: string }> = {
  active: { label: "占用中", cls: "badge-warn" },
  released: { label: "已释放", cls: "badge-muted" },
  issued: { label: "已签发", cls: "badge-ok" },
};

function fmtRxEye(e: { sph: number; cyl: number; axis: number; add: number }): string {
  const parts = [`${fmtD(e.sph)}DS`];
  if (e.cyl !== 0) parts.push(`${fmtD(e.cyl)}DC×${e.axis}°`);
  if (e.add !== 0) parts.push(`ADD ${fmtD(e.add)}`);
  return parts.join(" ");
}

/* ---------- 指标卡 ---------- */

function MetricCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={tone} />
    </article>
  );
}

/* ---------- 试戴片库存看板 ---------- */

function LensBoard({ state }: { state: AppState }) {
  const patientOf = (id: string) => state.patients.find((p) => p.id === id);
  return (
    <div className="panel">
      <h2 className="panel-title">试戴片库存</h2>
      <div className="lens-list">
        {state.lensSets.map((lens) => {
          const occupying = state.sessions.find(
            (s) => s.lensSetId === lens.id && s.status === "active",
          );
          const patient = occupying ? patientOf(occupying.patientId) : undefined;
          return (
            <div key={lens.id} className="lens-item">
              <div>
                <strong>{lens.code}</strong>
                <p>{lens.label}</p>
                {occupying && patient && (
                  <p className="lens-occupy">
                    {patient.name} · {occupying.start}–{occupying.end}
                  </p>
                )}
              </div>
              <span className={`badge ${occupying ? "badge-warn" : "badge-ok"}`}>
                {occupying ? "占用中" : "空闲"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 规则说明 ---------- */

function RulesCard() {
  return (
    <div className="panel">
      <h2 className="panel-title">闭环规则</h2>
      <ul className="rule-list">
        {Object.values(RULES).map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- 冲突记录 ---------- */

function ConflictLog({
  conflicts,
  onClear,
}: {
  conflicts: ConflictEntry[];
  onClear: () => void;
}) {
  return (
    <div className="panel">
      <div className="section-heading compact">
        <h2 className="panel-title">冲突记录</h2>
        {conflicts.length > 0 && (
          <button className="ghost-btn" onClick={onClear}>
            清空
          </button>
        )}
      </div>
      {conflicts.length === 0 ? (
        <p className="empty-hint">暂无冲突。重复占用同一时段同一试戴片时会在此列出。</p>
      ) : (
        <div className="conflict-list">
          {conflicts.map((c) => (
            <article key={c.id} className="conflict-item">
              <dl>
                <div>
                  <dt>患者</dt>
                  <dd>{c.patientName}</dd>
                </div>
                <div>
                  <dt>试戴片</dt>
                  <dd>{c.lensSetCode}</dd>
                </div>
                <div>
                  <dt>时段</dt>
                  <dd>{c.slot}</dd>
                </div>
                <div>
                  <dt>触发规则</dt>
                  <dd className="conflict-rule">{c.rule}</dd>
                </div>
              </dl>
              <p className="conflict-detail">
                {c.detail} · {fmtDateTime(c.at)}
              </p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 新建试戴评估 ---------- */

interface EyeDraft {
  va: string;
  adapt: string;
  discomfort: string;
}

interface TrialDraft {
  patientId: string;
  lensSetId: string;
  date: string;
  start: string;
  end: string;
  pd: string;
  eyes: Record<EyeSide, EyeDraft>;
  reason: string;
}

function emptyDraft(patientId: string): TrialDraft {
  return {
    patientId,
    lensSetId: "",
    date: todayStr(),
    start: "",
    end: "",
    pd: "63",
    eyes: {
      OD: { va: "", adapt: "", discomfort: "无" },
      OS: { va: "", adapt: "", discomfort: "无" },
    },
    reason: "",
  };
}

function EyeFields({
  side,
  value,
  onChange,
}: {
  side: EyeSide;
  value: EyeDraft;
  onChange: (patch: Partial<EyeDraft>) => void;
}) {
  const low = value.va !== "" && parseFloat(value.va) < LOW_VA;
  return (
    <fieldset className={`eye-fields ${low ? "eye-low" : ""}`}>
      <legend>
        {EYE_LABEL[side]}
        {low && <em>矫正视力未达{LOW_VA.toFixed(1)}</em>}
      </legend>
      <label>
        <span>矫正视力</span>
        <select value={value.va} onChange={(e) => onChange({ va: e.target.value })}>
          <option value="">请选择</option>
          {VA_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>适应时间（分钟）</span>
        <input
          type="number"
          min={0}
          max={180}
          step={5}
          placeholder="如 20"
          value={value.adapt}
          onChange={(e) => onChange({ adapt: e.target.value })}
        />
      </label>
      <label>
        <span>不适症状</span>
        <select value={value.discomfort} onChange={(e) => onChange({ discomfort: e.target.value })}>
          {DISCOMFORT_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

function TrialForm({
  state,
  onSubmit,
}: {
  state: AppState;
  onSubmit: (draft: TrialDraft) => boolean;
}) {
  const [draft, setDraft] = useState<TrialDraft>(() => emptyDraft(state.patients[0]?.id ?? ""));
  const patch = (p: Partial<TrialDraft>) => setDraft((d) => ({ ...d, ...p }));
  const patchEye = (side: EyeSide, p: Partial<EyeDraft>) =>
    setDraft((d) => ({ ...d, eyes: { ...d.eyes, [side]: { ...d.eyes[side], ...p } } }));

  const lowVA =
    (draft.eyes.OD.va !== "" && parseFloat(draft.eyes.OD.va) < LOW_VA) ||
    (draft.eyes.OS.va !== "" && parseFloat(draft.eyes.OS.va) < LOW_VA);

  const occupiedIds = new Set(
    state.sessions.filter((s) => s.status === "active").map((s) => s.lensSetId),
  );

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>试戴评估</p>
          <h2>新建试戴记录</h2>
        </div>
        <span className="hint">每次试戴占用一套试戴片</span>
      </div>

      <div className="form-grid">
        <label>
          <span>患者</span>
          <select value={draft.patientId} onChange={(e) => patch({ patientId: e.target.value })}>
            {state.patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.tag}）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>试戴片</span>
          <select value={draft.lensSetId} onChange={(e) => patch({ lensSetId: e.target.value })}>
            <option value="">请选择试戴片</option>
            {state.lensSets.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} · {l.label}
                {occupiedIds.has(l.id) ? "（当前占用中）" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>日期</span>
          <input type="date" value={draft.date} onChange={(e) => patch({ date: e.target.value })} />
        </label>
        <div className="slot-pair">
          <label>
            <span>开始</span>
            <input
              type="time"
              value={draft.start}
              onChange={(e) => patch({ start: e.target.value })}
            />
          </label>
          <label>
            <span>结束</span>
            <input type="time" value={draft.end} onChange={(e) => patch({ end: e.target.value })} />
          </label>
        </div>
        <label>
          <span>瞳距 PD（mm）</span>
          <input
            type="number"
            min={40}
            max={80}
            value={draft.pd}
            onChange={(e) => patch({ pd: e.target.value })}
          />
        </label>
      </div>

      <div className="eye-grid">
        <EyeFields side="OD" value={draft.eyes.OD} onChange={(p) => patchEye("OD", p)} />
        <EyeFields side="OS" value={draft.eyes.OS} onChange={(p) => patchEye("OS", p)} />
      </div>

      <label className={`reason-field ${lowVA ? "reason-required" : ""}`}>
        <span>
          低矫正视力原因{lowVA ? "（任一眼未达0.8，必填）" : "（任一眼未达0.8时必填）"}
        </span>
        <input
          placeholder="如：弱视待排查 / 屈光介质混浊 / 配合度差"
          value={draft.reason}
          onChange={(e) => patch({ reason: e.target.value })}
        />
      </label>

      <div className="form-actions">
        <button
          className="primary-action"
          onClick={() => {
            if (onSubmit(draft)) setDraft(emptyDraft(state.patients[0]?.id ?? ""));
          }}
        >
          开始试戴并占用试戴片
        </button>
      </div>
    </section>
  );
}

/* ---------- 试戴记录卡 ---------- */

function SessionCard({
  session,
  patient,
  lens,
  onSaveReason,
  onRelease,
  onIssue,
}: {
  session: TrialSession;
  patient?: Patient;
  lens?: LensSet;
  onSaveReason: (id: string, reason: string) => void;
  onRelease: (session: TrialSession) => void;
  onIssue: (session: TrialSession) => void;
}) {
  const [reason, setReason] = useState(session.lowVAReason);
  useEffect(() => {
    setReason(session.lowVAReason);
  }, [session.lowVAReason]);
  const meta = STATUS_META[session.status];
  const missing = reasonMissing(session);

  return (
    <article className={`session-card ${missing ? "session-blocked" : ""}`}>
      <header>
        <div>
          <h3>
            {patient?.name ?? session.patientId}
            <span className="session-sub">
              {lens?.code ?? session.lensSetId} · {slotLabel(session)} · PD {session.pd}mm
            </span>
          </h3>
        </div>
        <span className={`badge ${meta.cls}`}>{meta.label}</span>
      </header>

      <table className="eye-table">
        <thead>
          <tr>
            <th>眼别</th>
            <th>矫正视力</th>
            <th>适应时间</th>
            <th>不适症状</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(EYE_LABEL) as EyeSide[]).map((side) => {
            const eye = session.eyes[side];
            const low = eye.correctedVA < LOW_VA;
            return (
              <tr key={side}>
                <td>{EYE_LABEL[side]}</td>
                <td className={low ? "va-low" : ""}>
                  {eye.correctedVA.toFixed(1)}
                  {low && " ↓"}
                </td>
                <td>{eye.adaptMinutes} 分钟</td>
                <td>{eye.discomfort}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {needsReason(session) && (
        <div className={`reason-box ${missing ? "reason-missing" : ""}`}>
          <span>低矫正视力原因{missing ? "（未填写，签发与释放均被锁定）" : ""}</span>
          {session.status === "active" ? (
            <div className="reason-edit">
              <input
                placeholder="填写原因后才能签发或释放占用"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button onClick={() => onSaveReason(session.id, reason)}>保存原因</button>
            </div>
          ) : (
            <p>{session.lowVAReason || "—"}</p>
          )}
        </div>
      )}

      <footer>
        <span className="session-time">
          创建于 {fmtDateTime(session.createdAt)}
          {session.closedAt ? ` · 结束于 ${fmtDateTime(session.closedAt)}` : ""}
        </span>
        {session.status === "active" && (
          <div className="session-actions">
            <button onClick={() => onRelease(session)}>释放占用</button>
            <button className="primary-action" onClick={() => onIssue(session)}>
              签发处方
            </button>
          </div>
        )}
      </footer>
    </article>
  );
}

/* ---------- 处方卡（冻结 + 修订链 + 复诊调整） ---------- */

interface AdjustDraft {
  odSph: string;
  odCyl: string;
  odAxis: string;
  odAdd: string;
  osSph: string;
  osCyl: string;
  osAxis: string;
  osAdd: string;
  pd: string;
  reason: string;
}

function adjustDraftFrom(rx: RxSnapshot): AdjustDraft {
  return {
    odSph: String(rx.OD.sph),
    odCyl: String(rx.OD.cyl),
    odAxis: String(rx.OD.axis),
    odAdd: String(rx.OD.add),
    osSph: String(rx.OS.sph),
    osCyl: String(rx.OS.cyl),
    osAxis: String(rx.OS.axis),
    osAdd: String(rx.OS.add),
    pd: String(rx.pd),
    reason: "",
  };
}

function PrescriptionCard({
  rx,
  patient,
  onAdjust,
}: {
  rx: Prescription;
  patient?: Patient;
  onAdjust: (rxId: string, snapshot: RxSnapshot, reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const latest = rx.versions[0];
  const [draft, setDraft] = useState<AdjustDraft>(() => adjustDraftFrom(latest.rx));
  const patch = (p: Partial<AdjustDraft>) => setDraft((d) => ({ ...d, ...p }));

  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

  const submit = () => {
    const snapshot: RxSnapshot = {
      OD: { sph: num(draft.odSph), cyl: num(draft.odCyl), axis: num(draft.odAxis), add: num(draft.odAdd) },
      OS: { sph: num(draft.osSph), cyl: num(draft.osCyl), axis: num(draft.osAxis), add: num(draft.osAdd) },
      pd: num(draft.pd),
    };
    onAdjust(rx.id, snapshot, draft.reason);
    setDraft((d) => ({ ...d, reason: "" }));
    setOpen(false);
  };

  const eyeRow = (side: EyeSide, prefix: "od" | "os") => (
    <div className="adjust-eye">
      <strong>{EYE_LABEL[side]}</strong>
      {(["Sph", "Cyl", "Axis", "Add"] as const).map((f) => {
        const key = `${prefix}${f}` as keyof AdjustDraft;
        return (
          <label key={f}>
            <span>{f === "Sph" ? "球镜" : f === "Cyl" ? "柱镜" : f === "Axis" ? "轴位" : "ADD"}</span>
            <input
              type="number"
              step={f === "Axis" ? 1 : 0.25}
              value={draft[key]}
              onChange={(e) => patch({ [key]: e.target.value } as Partial<AdjustDraft>)}
            />
          </label>
        );
      })}
    </div>
  );

  return (
    <article className="rx-card">
      <header>
        <div>
          <h3>
            {patient?.name ?? rx.patientId}
            <span className="session-sub">
              处方 {rx.id} · 签发于 {fmtDateTime(rx.issuedAt)} · 共 {rx.versions.length} 版
            </span>
          </h3>
        </div>
        <span className="badge badge-ok">🔒 已冻结</span>
      </header>

      <table className="eye-table">
        <thead>
          <tr>
            <th>眼别</th>
            <th>当前处方（v{latest.version}）</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{EYE_LABEL.OD}</td>
            <td>{fmtRxEye(latest.rx.OD)}</td>
          </tr>
          <tr>
            <td>{EYE_LABEL.OS}</td>
            <td>{fmtRxEye(latest.rx.OS)}</td>
          </tr>
          <tr>
            <td>瞳距</td>
            <td>{latest.rx.pd} mm</td>
          </tr>
        </tbody>
      </table>

      <div className="version-chain">
        <h4>修订链</h4>
        <ol>
          {rx.versions.map((v, i) => (
            <li key={v.version} className={i === 0 ? "version-current" : ""}>
              <div>
                <strong>
                  v{v.version} · {v.source}
                </strong>
                {i === 0 && <span className="badge badge-ok">当前</span>}
              </div>
              <p>
                {fmtDateTime(v.createdAt)} · 原因：{v.reason}
              </p>
              <p className="version-rx">
                OD {fmtRxEye(v.rx.OD)} ｜ OS {fmtRxEye(v.rx.OS)} ｜ PD {v.rx.pd}mm
              </p>
            </li>
          ))}
        </ol>
      </div>

      <footer>
        <span className="session-time">签发后处方冻结，复诊调整只能新建带原因版本</span>
        <button
          onClick={() => {
            if (!open) setDraft(adjustDraftFrom(latest.rx));
            setOpen((o) => !o);
          }}
        >
          {open ? "收起调整" : "复诊调整"}
        </button>
      </footer>

      {open && (
        <div className="adjust-form">
          <div className="adjust-grid">
            {eyeRow("OD", "od")}
            {eyeRow("OS", "os")}
          </div>
          <div className="adjust-bottom">
            <label>
              <span>瞳距 PD（mm）</span>
              <input
                type="number"
                min={40}
                max={80}
                value={draft.pd}
                onChange={(e) => patch({ pd: e.target.value })}
              />
            </label>
            <label className="reason-field reason-required">
              <span>调整原因（必填，写入修订链）</span>
              <input
                placeholder="如：看近疲劳，下加光 +0.25D"
                value={draft.reason}
                onChange={(e) => patch({ reason: e.target.value })}
              />
            </label>
            <button className="primary-action" onClick={submit}>
              新建版本 v{rx.versions.length + 1}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/* ---------- 主应用 ---------- */

function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    saveState(state);
  }, [state]);

  const patientOf = (id: string) => state.patients.find((p) => p.id === id);
  const lensOf = (id: string) => state.lensSets.find((l) => l.id === id);

  const metrics = useMemo(() => {
    const active = state.sessions.filter((s) => s.status === "active");
    return {
      occupying: active.length,
      pendingReason: active.filter(reasonMissing).length,
      issued: state.prescriptions.length,
      conflicts: state.conflicts.length,
    };
  }, [state]);

  /* 新建试戴：校验 → 冲突检测 → 占用 */
  const submitTrial = (draft: TrialDraft): boolean => {
    const errors: string[] = [];
    if (!draft.patientId) errors.push("请选择患者");
    if (!draft.lensSetId) errors.push("请选择试戴片");
    if (!draft.date) errors.push("请选择日期");
    if (!draft.start || !draft.end) errors.push("请填写试戴时段");
    else if (toMinutes(draft.end) <= toMinutes(draft.start)) errors.push("结束时间必须晚于开始时间");
    if (!draft.eyes.OD.va) errors.push("请填写右眼矫正视力");
    if (!draft.eyes.OS.va) errors.push("请填写左眼矫正视力");
    if (draft.eyes.OD.adapt === "" || Number(draft.eyes.OD.adapt) < 0) errors.push("请填写右眼适应时间");
    if (draft.eyes.OS.adapt === "" || Number(draft.eyes.OS.adapt) < 0) errors.push("请填写左眼适应时间");
    const pd = Number(draft.pd);
    if (!draft.pd || Number.isNaN(pd) || pd < 40 || pd > 80) errors.push("瞳距需在 40–80mm 之间");
    if (errors.length > 0) {
      setNotice({ kind: "error", text: errors.join("；") });
      return false;
    }

    const candidate = {
      patientId: draft.patientId,
      lensSetId: draft.lensSetId,
      date: draft.date,
      start: draft.start,
      end: draft.end,
    };
    const hits = findConflicts(state, candidate);
    if (hits.length > 0) {
      const patient = patientOf(draft.patientId);
      const lens = lensOf(draft.lensSetId);
      const entries: ConflictEntry[] = hits.map((h) => ({
        id: uid("C"),
        at: Date.now(),
        patientName: patient?.name ?? draft.patientId,
        lensSetCode: lens?.code ?? draft.lensSetId,
        slot: slotLabel(candidate),
        rule: h.rule,
        detail: `与 ${patientOf(h.withSession.patientId)?.name ?? h.withSession.patientId} 的既有占用 ${h.withSession.start}–${h.withSession.end} 重叠`,
      }));
      setState((s) => ({ ...s, conflicts: [...entries, ...s.conflicts] }));
      setNotice({
        kind: "error",
        text: `占用冲突 ${hits.length} 条：患者、试戴片、时段与触发规则已列入冲突记录`,
      });
      return false;
    }

    const session: TrialSession = {
      id: uid("S"),
      ...candidate,
      pd,
      eyes: {
        OD: {
          correctedVA: parseFloat(draft.eyes.OD.va),
          adaptMinutes: Number(draft.eyes.OD.adapt),
          discomfort: draft.eyes.OD.discomfort,
        },
        OS: {
          correctedVA: parseFloat(draft.eyes.OS.va),
          adaptMinutes: Number(draft.eyes.OS.adapt),
          discomfort: draft.eyes.OS.discomfort,
        },
      },
      lowVAReason: draft.reason.trim(),
      status: "active",
      createdAt: Date.now(),
      closedAt: null,
    };
    setState((s) => ({ ...s, sessions: [session, ...s.sessions] }));
    setNotice(
      reasonMissing(session)
        ? {
            kind: "error",
            text: `试戴已创建并占用试戴片；存在矫正视力未达${LOW_VA.toFixed(1)}，补填原因前不得签发或释放（${RULES.R3}）`,
          }
        : { kind: "ok", text: "试戴记录已创建，试戴片已占用" },
    );
    return true;
  };

  const saveReason = (id: string, reason: string) => {
    if (!reason.trim()) {
      setNotice({ kind: "error", text: "原因不能为空" });
      return;
    }
    setState((s) => ({
      ...s,
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, lowVAReason: reason.trim() } : x)),
    }));
    setNotice({ kind: "ok", text: "原因已保存，签发与释放已解锁" });
  };

  /* R3：原因未填不得释放 */
  const releaseSession = (session: TrialSession) => {
    if (reasonMissing(session)) {
      setNotice({ kind: "error", text: `原因未填，不得释放占用（${RULES.R3}）` });
      return;
    }
    setState((s) => ({
      ...s,
      sessions: s.sessions.map((x) =>
        x.id === session.id ? { ...x, status: "released", closedAt: Date.now() } : x,
      ),
    }));
    setNotice({ kind: "ok", text: "占用已释放，试戴片恢复空闲" });
  };

  /* R3：原因未填不得签发；签发后处方冻结（R4） */
  const issueSession = (session: TrialSession) => {
    if (reasonMissing(session)) {
      setNotice({ kind: "error", text: `原因未填，不得签发处方（${RULES.R3}）` });
      return;
    }
    const lens = lensOf(session.lensSetId);
    if (!lens) return;
    const reason = session.lowVAReason.trim();
    const rx: Prescription = {
      id: uid("RX"),
      patientId: session.patientId,
      sessionId: session.id,
      frozen: true,
      issuedAt: Date.now(),
      versions: [
        {
          version: 1,
          source: "首次签发",
          reason: reason ? `首次签发；低矫正视力原因：${reason}` : "首次签发，试戴评估通过",
          createdAt: Date.now(),
          rx: { OD: { ...lens.rx.OD }, OS: { ...lens.rx.OS }, pd: session.pd },
        },
      ],
    };
    setState((s) => ({
      ...s,
      prescriptions: [rx, ...s.prescriptions],
      sessions: s.sessions.map((x) =>
        x.id === session.id ? { ...x, status: "issued", closedAt: Date.now() } : x,
      ),
    }));
    setNotice({ kind: "ok", text: `处方 ${rx.id} 已签发并冻结，后续调整须新建带原因版本` });
  };

  /* R4：复诊调整只能新建带原因版本 */
  const adjustPrescription = (rxId: string, snapshot: RxSnapshot, reason: string) => {
    if (!reason.trim()) {
      setNotice({ kind: "error", text: `调整原因必填（${RULES.R4}）` });
      return;
    }
    const vals = [snapshot.OD.sph, snapshot.OD.cyl, snapshot.OD.axis, snapshot.OD.add,
      snapshot.OS.sph, snapshot.OS.cyl, snapshot.OS.axis, snapshot.OS.add, snapshot.pd];
    if (vals.some((v) => Number.isNaN(v))) {
      setNotice({ kind: "error", text: "处方参数存在无效数值" });
      return;
    }
    setState((s) => ({
      ...s,
      prescriptions: s.prescriptions.map((p) =>
        p.id === rxId
          ? {
              ...p,
              versions: [
                {
                  version: p.versions.length + 1,
                  source: "复诊调整" as const,
                  reason: reason.trim(),
                  createdAt: Date.now(),
                  rx: snapshot,
                },
                ...p.versions,
              ],
            }
          : p,
      ),
    }));
    setNotice({ kind: "ok", text: "已新建带原因的复诊版本，历史版本保持冻结" });
  };

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-11 · port 5111</p>
          <h1>眼科验光记录</h1>
          <p className="subtitle">
            试戴评估 → 试戴片占用管控 → 处方签发 → 冻结与复诊修订的完整闭环
          </p>
        </div>
        <div className="stack-card">
          <span>闭环规则</span>
          <strong>占用互斥 · 低视力必填原因 · 签发冻结 · 修订留链</strong>
        </div>
      </section>

      {notice && (
        <div className={`notice notice-${notice.kind}`}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <section className="metrics-grid">
        <MetricCard label="试戴占用中" value={metrics.occupying} tone="status-watch" />
        <MetricCard label="待补原因" value={metrics.pendingReason} tone="status-danger" />
        <MetricCard label="已签发处方" value={metrics.issued} tone="status-ok" />
        <MetricCard label="冲突拦截" value={metrics.conflicts} tone="status-watch" />
      </section>

      <section className="workspace">
        <aside className="aside-col">
          <LensBoard state={state} />
          <RulesCard />
          <ConflictLog
            conflicts={state.conflicts}
            onClear={() => setState((s) => ({ ...s, conflicts: [] }))}
          />
          <button
            className="ghost-btn reset-btn"
            onClick={() => {
              if (window.confirm("重置为演示数据？当前记录、占用、签发与修订链将被清除。")) {
                setState(resetState());
                setNotice({ kind: "ok", text: "已重置为演示数据" });
              }
            }}
          >
            重置演示数据
          </button>
        </aside>

        <div className="main-col">
          <TrialForm state={state} onSubmit={submitTrial} />

          <section className="panel">
            <div className="section-heading">
              <div>
                <p>占用与评估</p>
                <h2>试戴记录</h2>
              </div>
            </div>
            <div className="record-list">
              {state.sessions.length === 0 && <p className="empty-hint">暂无试戴记录</p>}
              {state.sessions.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  patient={patientOf(s.patientId)}
                  lens={lensOf(s.lensSetId)}
                  onSaveReason={saveReason}
                  onRelease={releaseSession}
                  onIssue={issueSession}
                />
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="section-heading">
              <div>
                <p>签发与修订</p>
                <h2>已签发处方</h2>
              </div>
            </div>
            <div className="record-list">
              {state.prescriptions.length === 0 && <p className="empty-hint">暂无处方</p>}
              {state.prescriptions.map((rx) => (
                <PrescriptionCard
                  key={rx.id}
                  rx={rx}
                  patient={patientOf(rx.patientId)}
                  onAdjust={adjustPrescription}
                />
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

export default App;
