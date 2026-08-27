import { CalendarClock, CheckCircle2, ChevronDown, Clock3, FileUp, LoaderCircle, MessageSquareText, Play, Plus, RefreshCw, Trash2, Wrench, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { inferReasoningProfile, reasoningOptions, reasoningProfileName } from "../reasoning-profile";
import type { AutomationCompatibilityIssue, Bootstrap, Project, ReasoningEffort, Schedule, ScheduledTask } from "../types";
import { Modal } from "./Modal";
import { AutomationImportPanel } from "./AutomationImportPanel";
import { ModelCombobox } from "./ModelCombobox";

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

type ScheduleForm = {
  id?: string;
  name: string;
  projectId: string;
  prompt: string;
  type: Schedule["type"];
  minutes: number;
  time: string;
  days: number[];
  enabled: boolean;
  sandboxMode: "workspace" | "unrestricted";
  providerMode: "follow" | "openai" | "provider";
  providerId: string;
  model: string;
  reasoningEffort: ReasoningEffort | "";
  compatibility: AutomationCompatibilityIssue[];
  resolveCompatibility: boolean;
};

function emptyForm(projects: Project[]): ScheduleForm {
  return { name: "", projectId: projects[0]?.id || "", prompt: "", type: "daily", minutes: 60, time: "09:00", days: [1, 2, 3, 4, 5], enabled: true, sandboxMode: "workspace", providerMode: "follow", providerId: "", model: "", reasoningEffort: "", compatibility: [], resolveCompatibility: false };
}

function formFromTask(task: ScheduledTask): ScheduleForm {
  return {
    id: task.id,
    name: task.name,
    projectId: task.projectId,
    prompt: task.prompt,
    type: task.schedule.type,
    minutes: task.schedule.type === "interval" ? task.schedule.minutes : 60,
    time: task.schedule.type === "interval" ? "09:00" : task.schedule.time,
    days: task.schedule.type === "weekly" ? task.schedule.days : [1, 2, 3, 4, 5],
    enabled: task.enabled,
    sandboxMode: task.sandboxMode,
    providerMode: task.providerMode,
    providerId: task.providerId || "",
    model: task.model || "",
    reasoningEffort: task.reasoningEffort || "",
    compatibility: task.compatibility,
    resolveCompatibility: false,
  };
}

function blockingIssues(task: Pick<ScheduledTask, "compatibility">) {
  return task.compatibility.filter((issue) => issue.severity === "blocker");
}

function scheduleFromForm(form: ScheduleForm): Schedule {
  if (form.type === "interval") return { type: "interval", minutes: form.minutes };
  if (form.type === "weekly") return { type: "weekly", time: form.time, days: form.days };
  return { type: "daily", time: form.time };
}

function scheduleText(schedule: Schedule) {
  if (schedule.type === "interval") return `每 ${schedule.minutes} 分钟`;
  if (schedule.type === "daily") return `每天 ${schedule.time}`;
  return `每周${schedule.days.map((day) => weekdays[day]).join("、")} ${schedule.time}`;
}

function timeText(value?: number | null) {
  return value ? new Date(value * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

function durationText(startedAt: number, completedAt: number | null | undefined, now: number) {
  const seconds = Math.max(0, Math.round(((completedAt ?? now / 1000) - startedAt)));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function phaseText(phase: string) {
  const labels: Record<string, string> = {
    starting: "正在创建会话",
    thread_started: "会话已创建",
    turn_started: "主任务运行中",
    item_commandExecution: "正在执行命令",
    item_mcpToolCall: "正在调用工具",
    item_completed: "步骤已完成",
    subagents_waiting: "等待子代理",
    subagents_finalizing: "正在收口子代理",
    subagents_resumed: "主任务已恢复",
    subagents_failed: "子代理收口失败",
    service_restarted: "应用服务中途重启",
    start_failed: "启动失败",
    failed: "执行失败",
    completed: "全部完成",
  };
  return labels[phase] || phase.replaceAll("_", " ");
}

type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: ReasoningEffort; description?: string }>;
};

export function ScheduledTasksDialog({ open, bootstrap, onClose, onOpenThread }: {
  open: boolean;
  bootstrap: Bootstrap;
  onClose: () => void;
  onOpenThread: (threadId: string, projectId: string) => void;
}) {
  const projects = bootstrap.projects;
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [form, setForm] = useState<ScheduleForm>(() => emptyForm(projects));
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsWarning, setModelsWarning] = useState("");
  const selectedProject = projects.find((project) => project.id === form.projectId);
  const effectiveProviderId = form.providerMode === "provider"
    ? form.providerId
    : form.providerMode === "follow"
      ? selectedProject?.defaultProviderId || ""
      : "";
  const effectiveProvider = bootstrap.providers.find((provider) => provider.id === effectiveProviderId) ?? null;
  const selectedModelOption = models.find((model) => model.model === form.model);
  const effortOptions = useMemo(
    () => reasoningOptions(effectiveProvider, form.model, selectedModelOption?.supportedReasoningEfforts),
    [effectiveProvider, form.model, selectedModelOption],
  );

  async function load() {
    setLoading(true); setError("");
    try {
      const result = await api<{ data: ScheduledTask[]; safetyMode: "explicitUnrestrictedOptIn" }>("/api/schedules");
      setTasks(result.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "定时任务读取失败");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (!open) return;
    setForm((current) => current.projectId ? current : { ...current, projectId: projects[0]?.id || "" });
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { window.clearInterval(timer); window.clearInterval(clock); };
  }, [open, projects]);

  useEffect(() => {
    if (!open || !editing || (effectiveProviderId === "" && bootstrap.bridge.status !== "ready")) return;
    const controller = new AbortController();
    setModelsLoading(true);
    setModels([]);
    setModelsWarning("");
    api<{ data: ModelOption[]; warning?: string }>(`/api/models${effectiveProviderId ? `?providerId=${encodeURIComponent(effectiveProviderId)}` : ""}`, { signal: controller.signal })
      .then((result) => {
        setModels(result.data ?? []);
        if (result.warning) setModelsWarning(`模型列表读取失败，可手动填写：${result.warning}`);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setModelsWarning(reason instanceof Error ? reason.message : "模型列表读取失败，可手动填写模型 ID");
      })
      .finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    return () => controller.abort();
  }, [open, editing, effectiveProviderId, bootstrap.bridge.status]);

  function resetForm() {
    setForm(emptyForm(projects)); setEditing(false); setImporting(false); setError("");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusyId(form.id || "new"); setError(""); setNotice("");
    try {
      await api(form.id ? `/api/schedules/${form.id}` : "/api/schedules", {
        method: form.id ? "PATCH" : "POST",
        body: JSON.stringify({
          name: form.name,
          projectId: form.projectId,
          prompt: form.prompt,
          schedule: scheduleFromForm(form),
          enabled: form.enabled,
          sandboxMode: form.sandboxMode,
          providerMode: form.providerMode,
          providerId: form.providerMode === "provider" ? form.providerId : null,
          model: form.model,
          reasoningEffort: form.reasoningEffort,
          resolveCompatibility: form.resolveCompatibility,
        }),
      });
      setNotice(form.id ? "定时任务已更新。" : "定时任务已创建。应用服务运行时会按 NAS 系统时区触发。");
      resetForm();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "定时任务保存失败");
    } finally { setBusyId(""); }
  }

  async function toggle(task: ScheduledTask) {
    setBusyId(task.id); setError("");
    try {
      await api(`/api/schedules/${task.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !task.enabled }) });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "定时任务设置失败"); }
    finally { setBusyId(""); }
  }

  async function run(task: ScheduledTask) {
    setBusyId(task.id); setError(""); setNotice("");
    try {
      const result = await api<{ threadId: string }>(`/api/schedules/${task.id}/run`, { method: "POST", body: "{}" });
      setNotice(blockingIssues(task).length > 0
        ? `“${task.name}”兼容试运行已经开始；任务仍保持暂停，请根据结果完成适配后再启用。`
        : `“${task.name}”已经开始，执行结果会保存为一条新会话。`);
      await load();
      if (result.threadId) onOpenThread(result.threadId, task.projectId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "定时任务启动失败"); }
    finally { setBusyId(""); }
  }

  async function remove(task: ScheduledTask) {
    if (!window.confirm(`删除定时任务“${task.name}”？已有结果会话不会删除。`)) return;
    setBusyId(task.id); setError("");
    try {
      await api(`/api/schedules/${task.id}`, { method: "DELETE" });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "定时任务删除失败"); }
    finally { setBusyId(""); }
  }

  return <Modal open={open} title="定时任务" subtitle="由飞牛工作台在后台触发；应用服务停止或 NAS 关机时不会运行。" onClose={onClose} wide>
    <div className="schedule-safety"><CalendarClock size={18} /><span><strong>无人值守 · 独立批次 · 自动审批 · 默认项目沙箱</strong><small>每次触发都创建全新批次；旧失败只用于诊断，不占用本次重试次数。浏览器、渲染器或编码器受阻时，可按任务明确关闭 Codex 内置沙箱。</small></span></div>
    {error && <div className="settings-error">{error}</div>}
    {notice && <div className="settings-success">{notice}</div>}
    {importing ? <AutomationImportPanel projects={projects} onCancel={resetForm} onImported={(task, replacedExisting) => { const prefix = replacedExisting ? "已更新" : "已导入"; setNotice(blockingIssues(task).length > 0 ? `${prefix}电脑任务“${task.name}”并保持暂停；下一步请点“兼容试运行”。` : `${prefix}电脑任务“${task.name}”并已按原状态启用。`); setImporting(false); void load(); }} /> : !editing ? <>
      <div className="schedule-toolbar"><button className="secondary-button compact" disabled={projects.length === 0} onClick={() => { resetForm(); setImporting(true); }}><FileUp size={14} /> 从电脑 Codex 导入</button><button className="primary-button compact" disabled={projects.length === 0} onClick={() => { resetForm(); setEditing(true); }}><Plus size={14} /> 新建任务</button><button className="secondary-button compact" disabled={loading} onClick={() => void load()}><RefreshCw size={14} className={loading ? "spin" : ""} /> 刷新</button></div>
      <div className="schedule-list">
        {tasks.map((task) => {
          const expandedRun = task.runs.find((run) => run.id === expandedRunId);
          return <article className={`schedule-card ${task.enabled ? "" : "disabled"}`} key={task.id}>
            <span className="schedule-card-icon"><Clock3 size={18} /></span>
            <span className="schedule-card-copy"><strong>{task.name}</strong><small>{task.projectName} · {scheduleText(task.schedule)} · {task.networkAccess ? task.sandboxMode === "unrestricted" ? "已关闭 Codex 沙箱" : "项目可写沙箱" : "旧任务只读"}</small><em>{task.sourceAutomationId ? `电脑导入 · 记忆 ${Math.ceil(task.memoryBytes / 1024)}KB · ` : ""}{task.providerMode === "follow" ? "跟随项目供应商" : task.providerName || "供应商已移除"} · {task.model || "供应商默认模型"} · {task.reasoningEffort || "默认思考"} · 下次 {timeText(task.nextRunAt)} · 上次 {timeText(task.lastRunAt)}</em></span>
            <span className="schedule-card-actions"><label title={task.enabled ? "已启用" : blockingIssues(task).length > 0 ? "完成 fnOS 适配后才能启用" : "已暂停"}><input type="checkbox" checked={task.enabled} disabled={busyId === task.id || (!task.enabled && blockingIssues(task).length > 0)} onChange={() => void toggle(task)} />{task.enabled ? "启用" : "暂停"}</label><button className="secondary-button compact" disabled={Boolean(busyId)} onClick={() => void run(task)}><Play size={13} /> {blockingIssues(task).length > 0 ? "兼容试运行" : "立即运行"}</button><button className="secondary-button compact" onClick={() => { setForm(formFromTask(task)); setEditing(true); }}><Wrench size={13} /> {blockingIssues(task).length > 0 ? "编辑适配" : "编辑"}</button><button className="icon-button small danger" title="删除" disabled={busyId === task.id} onClick={() => void remove(task)}><Trash2 size={14} /></button></span>
            {blockingIssues(task).length > 0 && <div className="schedule-compatibility"><strong>需要先完成 fnOS 适配：</strong>{blockingIssues(task).map((issue) => issue.message).join("；")}<small>先点“兼容试运行”查看 NAS 上缺少的脚本或登录态，再点“编辑适配”修改任务内容；确认可以在 fnOS 执行后勾选适配确认并启用。</small></div>}
            {task.runs.length > 0 && <div className="schedule-runs">{task.runs.slice(0, 3).map((run) => <button className={run.id === expandedRunId ? "active" : ""} key={run.id} onClick={() => setExpandedRunId((current) => current === run.id ? null : run.id)} title="展开本批次运行诊断">{run.status === "running" ? <LoaderCircle size={12} className="spin" /> : run.status === "succeeded" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}<span>{timeText(run.startedAt)}</span><em>{run.status === "running" ? "运行中" : run.status === "succeeded" ? "已完成" : "失败"} · {phaseText(run.phase)} · {durationText(run.startedAt, run.completedAt, now)}</em><ChevronDown size={11} /></button>)}</div>}
            {expandedRun && <div className="schedule-run-detail">
              <header><span><strong>独立批次 {expandedRun.id.slice(0, 8)}</strong><small>{phaseText(expandedRun.phase)} · 最后记录 {timeText(expandedRun.lastEventAt)}</small></span>{expandedRun.threadId && <button className="secondary-button compact" onClick={() => onOpenThread(expandedRun.threadId as string, task.projectId)}><MessageSquareText size={13} /> 打开结果会话</button>}</header>
              {expandedRun.error && <pre className="schedule-run-error">{expandedRun.error}</pre>}
              <ol>{expandedRun.diagnostics.slice(-12).map((entry, index) => <li key={`${entry.at}-${entry.method}-${index}`}><time>{timeText(entry.at)}</time><span><strong>{phaseText(entry.phase)}</strong><small>{entry.summary || entry.method}</small></span></li>)}</ol>
              <footer>本批次的失败不会计入下一次定时触发；下一次仍从全新批次开始。</footer>
            </div>}
          </article>;
        })}
        {!loading && tasks.length === 0 && <div className="schedule-empty"><CalendarClock size={28} /><strong>还没有定时任务</strong><span>例如：每天 09:00 联网同步数据并把报告写入当前项目。</span></div>}
      </div>
    </> : <form className="schedule-form" onSubmit={(event) => void save(event)}>
      <div className="form-grid two"><label><span>任务名称</span><input required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="每日项目巡检" /></label><label><span>所属项目</span><select required value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
      <label><span>给 Codex 的任务内容</span><textarea required maxLength={20_000} rows={7} value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} placeholder="联网检查当前项目状态和最近变更，把报告写入 reports/status.md。" /></label>
      <div className="form-grid two">
        <label><span>模型供应商</span><select value={form.providerMode === "provider" ? `provider:${form.providerId}` : form.providerMode} onChange={(event) => {
          const value = event.target.value;
          if (value.startsWith("provider:")) {
            const providerId = value.slice("provider:".length);
            const provider = bootstrap.providers.find((item) => item.id === providerId);
            setForm({ ...form, providerMode: "provider", providerId, model: provider?.model || "", reasoningEffort: "" });
          } else {
            setForm({ ...form, providerMode: value as "follow" | "openai", providerId: "", model: "", reasoningEffort: "" });
          }
        }}><option value="follow">跟随所属项目默认</option><option value="openai">OpenAI / ChatGPT</option>{bootstrap.providers.filter((provider) => provider.enabled).map((provider) => <option key={provider.id} value={`provider:${provider.id}`}>{provider.name}</option>)}</select></label>
        <label><span>模型 ID {modelsLoading && <LoaderCircle size={12} className="spin" />}</span><ModelCombobox options={models.map((model) => ({ value: model.model, label: model.displayName }))} value={form.model} onChange={(model) => setForm({ ...form, model })} placeholder="留空则使用供应商默认模型" ariaLabel="定时任务模型 ID" /></label>
      </div>
      <label><span>思考强度 · {reasoningProfileName(inferReasoningProfile(effectiveProvider, form.model))}</span><select value={form.reasoningEffort} onChange={(event) => setForm({ ...form, reasoningEffort: event.target.value as ReasoningEffort | "" })}><option value="">跟随模型默认</option>{effortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.value}）</option>)}</select><small>{form.reasoningEffort ? effortOptions.find((option) => option.value === form.reasoningEffort)?.description : "只覆盖这条定时任务，不影响项目和普通会话。"}</small></label>
      {modelsWarning && <div className="settings-warning">{modelsWarning}</div>}
      {form.compatibility.some((issue) => issue.severity === "blocker") && <div className="schedule-compatibility editor"><strong>导入任务仍含 Windows 专属依赖</strong><span>{form.compatibility.filter((issue) => issue.severity === "blocker").map((issue) => issue.message).join("；")}</span><label className="toggle-row"><span>我已把这些依赖改成 fnOS 可用的脚本/API，并允许解除暂停</span><input type="checkbox" checked={form.resolveCompatibility} onChange={(event) => setForm({ ...form, resolveCompatibility: event.target.checked, enabled: event.target.checked ? form.enabled : false })} /></label></div>}
      <div className="form-grid two"><label><span>执行频率</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value as Schedule["type"] })}><option value="daily">每天</option><option value="weekly">每周</option><option value="interval">固定间隔</option></select></label>{form.type === "interval" ? <label><span>间隔分钟（5–10080）</span><input type="number" min={5} max={10_080} required value={form.minutes} onChange={(event) => setForm({ ...form, minutes: Number(event.target.value) })} /></label> : <label><span>执行时间（NAS 系统时区）</span><input type="time" required value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} /></label>}</div>
      {form.type === "weekly" && <div className="weekday-picker"><span>执行日期</span><div>{weekdays.map((day, index) => <button type="button" className={form.days.includes(index) ? "active" : ""} key={day} onClick={() => setForm({ ...form, days: form.days.includes(index) ? form.days.filter((value) => value !== index) : [...form.days, index].sort() })}>周{day}</button>)}</div></div>}
      <label className="toggle-row"><span>关闭 Codex 内置沙箱（仅用于受阻的浏览器、渲染器或编码器；可能访问 fnOS 应用账号可访问的项目外路径）</span><input type="checkbox" checked={form.sandboxMode === "unrestricted"} onChange={(event) => { if (event.target.checked && !window.confirm("关闭 Codex 内置沙箱后，这条定时任务可能访问项目目录外、但 fnOS 应用账号有权访问的文件。仅应对可信任务启用。确定继续吗？")) return; setForm({ ...form, sandboxMode: event.target.checked ? "unrestricted" : "workspace" }); }} /></label>
      <label className="toggle-row"><span>{form.id ? "保存后启用" : "创建后启用"}</span><input type="checkbox" checked={form.enabled} disabled={form.compatibility.some((issue) => issue.severity === "blocker") && !form.resolveCompatibility} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /></label>
      <div className="schedule-form-actions"><button type="button" className="secondary-button" onClick={resetForm}>取消</button><button className="primary-button" disabled={Boolean(busyId) || !form.projectId}>{busyId ? <LoaderCircle size={14} className="spin" /> : null}{form.id ? "保存修改" : "创建任务"}</button></div>
    </form>}
  </Modal>;
}
