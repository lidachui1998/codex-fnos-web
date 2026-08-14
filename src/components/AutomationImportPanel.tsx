import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { AutomationImportPreview, Project, ScheduledTask } from "../types";

type Props = {
  projects: Project[];
  onCancel: () => void;
  onImported: (task: ScheduledTask, replacedExisting: boolean) => void;
};

export function AutomationImportPanel({ projects, onCancel, onImported }: Props) {
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [automationFile, setAutomationFile] = useState<File | null>(null);
  const [memoryFile, setMemoryFile] = useState<File | null>(null);
  const [payload, setPayload] = useState<{ automationToml: string; memory: string } | null>(null);
  const [preview, setPreview] = useState<AutomationImportPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setPreview(null);
    setPayload(null);
  }, [automationFile, memoryFile, projectId]);

  async function readPayload() {
    if (!automationFile) throw new Error("请选择电脑 Codex 的 automation.toml");
    return {
      automationToml: await automationFile.text(),
      memory: memoryFile ? await memoryFile.text() : "",
    };
  }

  async function inspect() {
    setBusy("preview"); setError("");
    try {
      const files = await readPayload();
      const result = await api<{ preview: AutomationImportPreview }>("/api/schedules/import/preview", {
        method: "POST",
        body: JSON.stringify({ projectId, ...files }),
      });
      setPayload(files);
      setPreview(result.preview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "迁移文件解析失败");
    } finally { setBusy(null); }
  }

  async function importTask() {
    if (!payload || !preview) return;
    setBusy("import"); setError("");
    try {
      const result = await api<{ task: ScheduledTask; replacedExisting: boolean }>("/api/schedules/import", {
        method: "POST",
        body: JSON.stringify({ projectId, ...payload }),
      });
      onImported(result.task, result.replacedExisting);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "定时任务导入失败");
    } finally { setBusy(null); }
  }

  return <div className="automation-import">
    <div className="automation-import-intro"><FileUp size={20} /><span><strong>从电脑 Codex 导入</strong><small>保留原提示词、RRULE、模型、思考强度和 memory.md，并把 Windows 工作目录映射到所选 fnOS 项目。</small></span></div>
    {error && <div className="settings-error">{error}</div>}
    <div className="form-grid two">
      <label><span>接收任务的 fnOS 项目</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.path}</option>)}</select></label>
      <label><span>电脑 automation.toml</span><input type="file" accept=".toml,text/plain" onChange={(event) => setAutomationFile(event.target.files?.[0] || null)} /></label>
    </div>
    <label><span>电脑 memory.md（可选，完整保存；每次运行仅注入末尾 16000 字符）</span><input type="file" accept=".md,text/markdown,text/plain" onChange={(event) => setMemoryFile(event.target.files?.[0] || null)} /></label>
    {preview && <div className="automation-preview">
      <header><CheckCircle2 size={16} /><span><strong>{preview.name}</strong><small>{preview.sourceCwd || "未记录原目录"} → {preview.targetCwd}</small></span></header>
      <dl><div><dt>模型</dt><dd>{preview.model || "跟随项目"}</dd></div><div><dt>思考强度</dt><dd>{preview.reasoningEffort || "跟随默认"}</dd></div><div><dt>记忆</dt><dd>{Math.ceil(preview.memoryBytes / 1024)} KB</dd></div><div><dt>导入后</dt><dd>{preview.enabledAfterImport ? "立即启用" : "自动暂停"}</dd></div></dl>
      {preview.issues.map((issue) => <div className={`automation-issue ${issue.severity}`} key={`${issue.code}:${issue.message}`}><AlertTriangle size={14} /><span><strong>{issue.severity === "blocker" ? "兼容阻塞" : "需要确认"}</strong><small>{issue.message}</small></span></div>)}
      {preview.issues.length === 0 && <div className="settings-success">未发现 Windows 专属依赖，可以按原启用状态导入。</div>}
    </div>}
    <div className="schedule-form-actions">
      <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
      {!preview
        ? <button type="button" className="primary-button" disabled={!automationFile || !projectId || Boolean(busy)} onClick={() => void inspect()}>{busy === "preview" && <LoaderCircle size={14} className="spin" />}解析兼容性</button>
        : <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void importTask()}>{busy === "import" && <LoaderCircle size={14} className="spin" />}确认导入{preview.enabledAfterImport ? "并启用" : "（保持暂停）"}</button>}
    </div>
  </div>;
}
