import { Check, ChevronDown, KeyRound, LoaderCircle, RefreshCw, Settings2, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { inferReasoningProfile, reasoningOptions, reasoningProfileName } from "../reasoning-profile";
import type { Bootstrap, ReasoningEffort } from "../types";
import { ModelCombobox } from "./ModelCombobox";

type ModelOption = {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort: ReasoningEffort; description?: string }>;
  defaultReasoningEffort?: ReasoningEffort;
};

type Props = {
  bootstrap: Bootstrap;
  open: boolean;
  providerId: string;
  model: string;
  effort: ReasoningEffort | "";
  threadProviderId: string | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (providerId: string, model: string, effort: ReasoningEffort | "") => Promise<void> | void;
  onChanged: () => Promise<void>;
  onAdvancedSettings: () => void;
};

export function ModelPicker({ bootstrap, open, providerId, model, effort, threadProviderId, onOpenChange, onSelect, onChanged, onAdvancedSettings }: Props) {
  const [draftProviderId, setDraftProviderId] = useState(providerId);
  const [draftModel, setDraftModel] = useState(model);
  const [draftEffort, setDraftEffort] = useState<ReasoningEffort | "">(effort);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const provider = bootstrap.providers.find((item) => item.id === draftProviderId) ?? null;
  const activeProvider = bootstrap.providers.find((item) => item.id === providerId) ?? null;
  const providerName = activeProvider?.name || "OpenAI / ChatGPT";
  const activeModel = model || activeProvider?.model || "默认模型";
  const activeEffort = effort ? ` · ${effort}` : "";
  const providerWillChange = threadProviderId !== null && threadProviderId !== draftProviderId;
  const modelSourceState = draftProviderId ? "custom" : bootstrap.bridge.status;

  useEffect(() => {
    if (!open) return;
    setDraftProviderId(providerId);
    setDraftModel(model);
    setDraftEffort(effort);
    setToken("");
    setNotice("");
    setError("");
  }, [open, providerId, model, effort]);

  useEffect(() => {
    if (!open || (modelSourceState !== "custom" && modelSourceState !== "ready")) return;
    const controller = new AbortController();
    setLoading(true);
    setModels([]);
    setNotice("");
    setError("");
    api<{ data: ModelOption[]; source?: string; warning?: string }>(`/api/models${draftProviderId ? `?providerId=${encodeURIComponent(draftProviderId)}` : ""}`, { signal: controller.signal })
      .then((result) => {
        setModels(result.data ?? []);
        if (!draftModel) {
          const preferred = result.data?.find((item) => item.isDefault) ?? result.data?.[0];
          if (preferred) setDraftModel(preferred.model);
        }
        if (result.warning) setNotice(`无法读取供应商 /models，暂时使用已配置模型：${result.warning}`);
        else if (draftProviderId) setNotice(`已从供应商 /models 获取 ${result.data?.length ?? 0} 个模型`);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "模型列表读取失败");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, draftProviderId, modelSourceState, refreshKey]);

  const quickModels = useMemo(() => models.slice(0, 6), [models]);
  const selectedModelOption = models.find((item) => item.model === draftModel);
  const effortOptions = reasoningOptions(provider, draftModel, selectedModelOption?.supportedReasoningEfforts);
  const reasoningProfile = inferReasoningProfile(provider, draftModel);

  function chooseModel(nextModel: string) {
    setDraftModel(nextModel);
    const option = models.find((item) => item.model === nextModel);
    const nextOptions = reasoningOptions(provider, nextModel, option?.supportedReasoningEfforts);
    if (draftEffort && !nextOptions.some((item) => item.value === draftEffort)) setDraftEffort(option?.defaultReasoningEffort ?? "");
  }

  function changeProvider(nextId: string) {
    const next = bootstrap.providers.find((item) => item.id === nextId);
    setDraftProviderId(nextId);
    setDraftModel(next?.model ?? "");
    setDraftEffort("");
    setModels([]);
    setNotice("");
    setError("");
  }

  async function saveToken() {
    const value = token.trim();
    if (!value) return;
    setSavingToken(true);
    setNotice("");
    setError("");
    try {
      if (draftProviderId) {
        await api(`/api/providers/${draftProviderId}`, { method: "PATCH", body: JSON.stringify({ apiKey: value }) });
      } else {
        await api("/api/account/login", { method: "POST", body: JSON.stringify({ type: "apiKey", apiKey: value }) });
      }
      setToken("");
      setNotice(`${provider?.name || "OpenAI"} API 令牌已保存`);
      await onChanged();
      setRefreshKey((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "API 令牌保存失败");
    } finally {
      setSavingToken(false);
    }
  }

  return (
    <div className="model-picker-wrap">
      <button className="provider-pill" onClick={() => onOpenChange(!open)} aria-haspopup="dialog" aria-expanded={open}>
        <span><strong>{providerName}</strong><small>{activeModel}{activeEffort}</small></span><ChevronDown size={13} />
      </button>
      {open && <>
        <button className="model-picker-scrim" onClick={() => onOpenChange(false)} aria-label="关闭模型选择" />
        <section className="model-picker" role="dialog" aria-label="选择模型和设置 API 令牌">
          <header><div><Sparkles size={17} /><span><strong>模型与 API</strong><small>选择后立即用于下一条消息</small></span></div><button className="icon-button small" onClick={() => onOpenChange(false)} aria-label="关闭"><X size={16} /></button></header>
          <div className="model-picker-body">
            <label><span>供应商</span><select value={draftProviderId} onChange={(event) => changeProvider(event.target.value)}><option value="">OpenAI / ChatGPT</option>{bootstrap.providers.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label><span>模型 ID {loading && <LoaderCircle size={12} className="spin" />}</span><ModelCombobox options={models.map((item) => ({ value: item.model, label: item.displayName }))} value={draftModel} onChange={chooseModel} placeholder="输入或下拉选择模型" /></label>
            {quickModels.length > 0 && <div className="quick-models">{quickModels.map((item) => <button key={item.id} className={draftModel === item.model ? "active" : ""} onClick={() => chooseModel(item.model)}>{item.displayName}</button>)}</div>}
            {effortOptions.length > 0 && <label><span>思考程度 · {reasoningProfileName(reasoningProfile)}</span><select value={draftEffort} onChange={(event) => setDraftEffort(event.target.value as ReasoningEffort | "")}><option value="">跟随模型默认</option>{effortOptions.map((item) => <option key={item.value} value={item.value}>{item.label}（{item.value}）</option>)}</select><small>{draftEffort ? effortOptions.find((item) => item.value === draftEffort)?.description : "不同供应商和模型只显示它实际支持的档位。"}</small></label>}
            {effortOptions.length === 0 && <div className="model-note">当前模型没有可配置的思考程度，将使用供应商默认行为。</div>}
            {draftProviderId && <button type="button" className="refresh-models" onClick={() => setRefreshKey((current) => current + 1)} disabled={loading}><RefreshCw size={13} className={loading ? "spin" : ""} /> 从供应商 /models 重新获取</button>}
            {providerWillChange && <div className="model-note">供应商与当前会话不同：普通发送会创建新会话；在历史回复旁点“重新生成”可明确选择该供应商，并留在当前会话。</div>}
            <button className="primary-button apply-model" disabled={!draftModel.trim() && Boolean(draftProviderId)} onClick={async () => { await onSelect(draftProviderId, draftModel.trim(), draftEffort); onOpenChange(false); }}><Check size={16} /> 使用这个模型</button>

            <form className="quick-token" onSubmit={(event) => { event.preventDefault(); void saveToken(); }}>
              <div><KeyRound size={15} /><span><strong>直接设置 API 令牌</strong><small>{provider ? `更新 ${provider.name} 的令牌` : "连接 OpenAI API Key"}</small></span></div>
              <input className="sr-only" name="username" autoComplete="username" value={provider?.name || "OpenAI"} readOnly tabIndex={-1} aria-hidden="true" />
              <div className="quick-token-row"><input name="apiKey" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={provider?.apiKeyHint || "粘贴 API Key"} autoComplete="new-password" /><button type="submit" className="secondary-button compact" disabled={!token.trim() || savingToken}>{savingToken ? "保存中" : "保存"}</button></div>
            </form>
            {notice && <div className="model-picker-notice">{notice}</div>}
            {error && <div className="form-error">{error}</div>}
            <button className="advanced-settings" onClick={() => { onOpenChange(false); onAdvancedSettings(); }}><Settings2 size={14} /> 添加第三方 API、代理或高级请求头</button>
          </div>
        </section>
      </>}
    </div>
  );
}
