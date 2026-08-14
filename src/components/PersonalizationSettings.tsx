import { Save, Server, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Bootstrap } from "../types";

export function PersonalizationSettings({ settings, onChanged }: {
  settings: Bootstrap["settings"];
  onChanged: () => Promise<void>;
}) {
  const [personalInstructions, setPersonalInstructions] = useState(settings.personalInstructions);
  const [fnosInstructions, setFnosInstructions] = useState(settings.fnosInstructions);
  const [fnosInstructionsEnabled, setFnosInstructionsEnabled] = useState(settings.fnosInstructionsEnabled);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setPersonalInstructions(settings.personalInstructions);
    setFnosInstructions(settings.fnosInstructions);
    setFnosInstructionsEnabled(settings.fnosInstructionsEnabled);
  }, [settings.personalInstructions, settings.fnosInstructions, settings.fnosInstructionsEnabled]);

  async function save() {
    setSaving(true); setNotice(""); setError("");
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ personalInstructions, fnosInstructions, fnosInstructionsEnabled }),
      });
      setNotice("个性化指令已保存，将从新建会话和新的定时运行开始生效");
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "个性化指令保存失败");
    } finally { setSaving(false); }
  }

  return <div className="settings-section personalization-settings">
    <div className="section-heading"><div><h3>个性化指令</h3><p>服务端保存并作为 developer instructions 注入新会话，不会显示成普通聊天消息。</p></div></div>
    {notice && <div className="settings-success">{notice}</div>}
    {error && <div className="settings-error">{error}</div>}
    <label className="instruction-field">
      <span><UserRound size={18} /><strong>个人指令</strong><small>填写你的工作习惯、输出偏好和长期背景，类似 ChatGPT 的自定义指令。</small></span>
      <textarea rows={8} maxLength={12_000} value={personalInstructions} onChange={(event) => setPersonalInstructions(event.target.value)} placeholder="例如：默认用中文回答；修改配置前先备份；完成后给出验证结果……" />
      <em>{personalInstructions.length}/12000</em>
    </label>
    <label className="toggle-row instruction-toggle"><span><Server size={18} /><strong>默认注入飞牛 NAS 环境说明</strong><small>避免 Codex 把 NAS 当成 Windows、macOS 或普通云服务器。</small></span><input type="checkbox" checked={fnosInstructionsEnabled} onChange={(event) => setFnosInstructionsEnabled(event.target.checked)} /></label>
    <label className={`instruction-field ${fnosInstructionsEnabled ? "" : "disabled"}`}>
      <span><strong>飞牛环境默认指令</strong><small>可以按你的 NAS 实际环境继续补充；关闭上方开关后不会注入。</small></span>
      <textarea rows={11} maxLength={12_000} disabled={!fnosInstructionsEnabled} value={fnosInstructions} onChange={(event) => setFnosInstructions(event.target.value)} />
      <em>{fnosInstructions.length}/12000</em>
    </label>
    <div className="settings-warning">已有会话会保留创建时的指令，避免中途重写上下文；要使用新指令请新建会话。</div>
    <div className="form-actions"><button className="primary-button" disabled={saving} onClick={() => void save()}><Save size={15} /> {saving ? "保存中…" : "保存个性化指令"}</button></div>
  </div>;
}
