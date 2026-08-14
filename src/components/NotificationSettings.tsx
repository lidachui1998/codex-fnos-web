import { BellRing, CheckCircle2, LoaderCircle, MessageSquareText, Save, Send, TestTube2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { NotificationChannel } from "../types";

type ExternalChannel = "feishu" | "hermes";
type EventType = NotificationChannel["events"][number];
type ChannelForm = { enabled: boolean; webhookUrl: string; secret: string; events: EventType[] };

const defaultEvents: EventType[] = ["completed", "failed", "timeout", "waiting"];
const emptyForm = (): ChannelForm => ({ enabled: false, webhookUrl: "", secret: "", events: [...defaultEvents] });
const eventLabels: Record<EventType, string> = {
  completed: "完成",
  failed: "失败",
  timeout: "超时",
  waiting: "等待输入",
};

export function NotificationSettings() {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [forms, setForms] = useState<Record<ExternalChannel, ChannelForm>>({ feishu: emptyForm(), hermes: emptyForm() });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const result = await api<{ data: NotificationChannel[] }>("/api/notification-channels");
    setChannels(result.data);
    setForms((current) => {
      const next = { ...current };
      for (const name of ["feishu", "hermes"] as const) {
        const saved = result.data.find((item) => item.channel === name);
        if (saved) next[name] = { enabled: saved.enabled, webhookUrl: "", secret: "", events: saved.events };
      }
      return next;
    });
  }

  useEffect(() => {
    void load().catch((reason) => setError(reason instanceof Error ? reason.message : "通知设置加载失败"));
  }, []);

  function update(name: ExternalChannel, patch: Partial<ChannelForm>) {
    setForms((current) => ({ ...current, [name]: { ...current[name], ...patch } }));
  }

  function toggleEvent(name: ExternalChannel, event: EventType) {
    const current = forms[name].events;
    update(name, { events: current.includes(event) ? current.filter((item) => item !== event) : [...current, event] });
  }

  async function save(name: ExternalChannel) {
    setBusy(`save-${name}`); setNotice(""); setError("");
    try {
      const form = forms[name];
      await api(`/api/notification-channels/${name}`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled: form.enabled,
          events: form.events,
          webhookUrl: form.webhookUrl || undefined,
          secret: form.secret || undefined,
        }),
      });
      await load();
      setNotice(`${name === "feishu" ? "飞书" : "Hermes 微信"}通知设置已加密保存`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "通知设置保存失败");
    } finally { setBusy(null); }
  }

  async function test(name: "fnos" | ExternalChannel) {
    setBusy(`test-${name}`); setNotice(""); setError("");
    try {
      await api(`/api/notification-channels/${name}/test`, { method: "POST", body: "{}" });
      setNotice(name === "fnos" ? "测试通知已写入通知中心" : `${name === "feishu" ? "飞书" : "Hermes 微信"}测试通知已发送`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "测试通知发送失败");
    } finally { setBusy(null); }
  }

  function channelCard(name: ExternalChannel) {
    const saved = channels.find((item) => item.channel === name);
    const form = forms[name];
    const title = name === "feishu" ? "飞书群机器人" : "Hermes 微信通知";
    const description = name === "feishu"
      ? "使用飞书 V2 自定义机器人 Webhook；签名 secret 可选，建议在飞书安全设置中启用。"
      : "按 Hermes notify 路由协议，对原始 JSON Body 做 HMAC-SHA256 后发送到微信。";
    return <article className="notification-channel-card" key={name}>
      <header>
        <span className={`channel-mark ${name}`}>{name === "feishu" ? <MessageSquareText size={19} /> : <Send size={19} />}</span>
        <span><strong>{title}</strong><small>{description}</small></span>
        <label className="channel-enable"><input type="checkbox" checked={form.enabled} onChange={(event) => update(name, { enabled: event.target.checked })} /><span>{form.enabled ? "已启用" : "未启用"}</span></label>
      </header>
      <div className="notification-channel-fields">
        <label><span>Webhook 地址</span><input value={form.webhookUrl} onChange={(event) => update(name, { webhookUrl: event.target.value })} placeholder={saved?.webhookUrlHint || (name === "feishu" ? "https://open.feishu.cn/open-apis/bot/v2/hook/..." : "http://192.168.5.4:8644/webhooks/notify")} /><small>{saved?.hasWebhookUrl ? "留空会继续使用已保存地址" : "地址仅在服务端加密保存"}</small></label>
        <label><span>{name === "feishu" ? "签名 secret（可选）" : "notify 路由 secret"}</span><input type="password" value={form.secret} onChange={(event) => update(name, { secret: event.target.value })} placeholder={saved?.secretHint || (name === "feishu" ? "未开启签名可留空" : "粘贴 Hermes route secret")} /><small>{saved?.hasSecret ? "留空会继续使用已保存 secret" : name === "hermes" ? "Hermes 启用时必填" : "飞书开启签名校验时填写"}</small></label>
      </div>
      <div className="notification-event-options"><span>发送事件</span>{defaultEvents.map((event) => <label key={event}><input type="checkbox" checked={form.events.includes(event)} onChange={() => toggleEvent(name, event)} /> {eventLabels[event]}</label>)}</div>
      <footer><button className="secondary-button compact" disabled={!saved?.enabled || busy !== null} onClick={() => void test(name)}>{busy === `test-${name}` ? <LoaderCircle className="spin" size={14} /> : <TestTube2 size={14} />} 测试</button><button className="primary-button compact" disabled={busy !== null} onClick={() => void save(name)}>{busy === `save-${name}` ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />} 保存</button></footer>
    </article>;
  }

  return <div className="settings-section notification-settings">
    <div className="section-heading"><div><h3>通知中心与外部提醒</h3><p>任务完成、失败、超时或等待输入时提醒；运行中状态只记录在本地通知中心。</p></div></div>
    {notice && <div className="success-banner"><CheckCircle2 size={16} /> {notice}</div>}
    {error && <div className="form-error">{error}</div>}
    <article className="notification-channel-card native">
      <header><span className="channel-mark fnos"><BellRing size={19} /></span><span><strong>fnOS 工作台通知中心</strong><small>始终启用，数据保存在应用 SQLite 中；支持未读、运行中、失败和定时任务筛选。</small></span><em>本地</em></header>
      <footer><span>飞牛官方暂未公开向系统通知中心写入消息的 API，因此不会调用私有接口或改系统数据库。</span><button className="secondary-button compact" disabled={busy !== null} onClick={() => void test("fnos")}><TestTube2 size={14} /> 写入测试通知</button></footer>
    </article>
    {channelCard("feishu")}
    {channelCard("hermes")}
    <div className="settings-warning">Webhook 地址与 secret 使用应用主密钥 AES-256-GCM 加密；界面和日志只显示掩码。外部消息默认只包含任务名、类型、状态、简短结果或错误，不会附带项目文件。</div>
  </div>;
}
