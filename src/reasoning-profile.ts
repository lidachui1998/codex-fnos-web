import type { ProviderProfile, ReasoningEffort, ReasoningProfile } from "./types";

export type ReasoningOption = {
  value: ReasoningEffort;
  label: string;
  description: string;
};

const labels: Record<ReasoningEffort, string> = {
  none: "关闭思考",
  minimal: "极简",
  low: "快速",
  medium: "标准",
  high: "深入",
  xhigh: "超强",
  max: "最大",
  ultra: "极限",
};

const descriptions: Record<ReasoningEffort, string> = {
  none: "优先速度，不额外推理",
  minimal: "只做必要推理",
  low: "更快、消耗更少",
  medium: "速度和质量平衡",
  high: "适合复杂编码和分析",
  xhigh: "更深入的代理式工作",
  max: "使用模型支持的最高强度",
  ultra: "供应商自定义的极限强度",
};

function options(values: ReasoningEffort[]) {
  return values.map((value) => ({ value, label: labels[value], description: descriptions[value] }));
}

export function inferReasoningProfile(provider: ProviderProfile | null, model: string): ReasoningProfile {
  if (provider?.reasoningProfile && provider.reasoningProfile !== "auto") return provider.reasoningProfile;
  const value = `${provider?.name ?? ""} ${provider?.baseUrl ?? ""} ${model}`.toLowerCase();
  if (value.includes("claude") || value.includes("anthropic")) return "anthropic";
  if (value.includes("deepseek")) return "deepseek";
  if (/qwen|qwq|dashscope|aliyun/.test(value)) return "qwen";
  if (/kimi|moonshot/.test(value)) return "kimi";
  if (/glm|chatglm|zhipu|bigmodel/.test(value)) return "glm";
  if (/gemini|google/.test(value)) return "gemini";
  if (/gpt|openai|\bo[134](?:-|\b)/.test(value)) return "openai";
  return "generic";
}

export function reasoningOptions(
  provider: ProviderProfile | null,
  model: string,
  official?: Array<{ reasoningEffort: ReasoningEffort; description?: string }>,
): ReasoningOption[] {
  if (official?.length) {
    return official.map(({ reasoningEffort, description }) => ({
      value: reasoningEffort,
      label: labels[reasoningEffort],
      description: description || descriptions[reasoningEffort],
    }));
  }
  const profile = inferReasoningProfile(provider, model);
  const value = model.toLowerCase();
  if (profile === "none") return [];
  if (profile === "openai") {
    if (/gpt-5\.6/.test(value)) return options(["none", "low", "medium", "high", "xhigh", "max"]);
    if (/gpt-5\.[45]/.test(value)) return options(["none", "low", "medium", "high", "xhigh"]);
    if (/gpt-5/.test(value)) return options(["minimal", "low", "medium", "high"]);
    if (/^o[134](?:-|$)/.test(value)) return options(["low", "medium", "high"]);
    return [];
  }
  if (profile === "anthropic") {
    const advanced = /claude.*(?:5|4[.-][6-9]|fable|mythos)/.test(value);
    return options(advanced ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high"]);
  }
  if (profile === "deepseek") return options(["high", "max"]);
  if (profile === "qwen") {
    return /qwen3\.8.*max/.test(value)
      ? options(["none", "low", "medium", "xhigh"])
      : options(["none", "low", "medium", "high"]);
  }
  if (profile === "glm") return options(["none", "high", "max"]);
  if (profile === "kimi") return options(["none", "medium", "high"]);
  if (profile === "gemini") return options(["low", "medium", "high"]);
  return options(["low", "medium", "high"]);
}

export function reasoningProfileName(profile: ReasoningProfile) {
  return ({
    auto: "自动识别",
    openai: "OpenAI / ChatGPT",
    anthropic: "Anthropic / Claude",
    deepseek: "DeepSeek",
    qwen: "通义千问 / Qwen",
    kimi: "Kimi",
    glm: "智谱 GLM",
    gemini: "Google Gemini",
    generic: "通用 OpenAI 兼容",
    none: "不提供思考档位",
  } satisfies Record<ReasoningProfile, string>)[profile];
}
