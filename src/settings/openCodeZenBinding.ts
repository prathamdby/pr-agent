const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_RESPONSES_API = "openai-responses";
const OPENCODE_PROVIDER = "opencode";
const OPENCODE_ZEN_ALIASES = new Set(["opencode", "opencode-zen"]);
const MUSE_SPARK_MODEL_PREFIX = "muse-spark-";

export const MUSE_SPARK_THINKING_LEVEL_MAP = {
  off: "minimal",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
} as const;

export type OpenCodeZenThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export type OpenCodeZenBindableModel = {
  readonly id: string;
  readonly provider: string;
  readonly api: string;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null | undefined>>;
};

export function isOpenCodeZenProvider(provider: string): boolean {
  return OPENCODE_ZEN_ALIASES.has(provider);
}

export function isOpenCodeZenMuseSparkModel(model: string): boolean {
  return model.startsWith(MUSE_SPARK_MODEL_PREFIX);
}

export function mapOpenCodeZenThinkingLevel(level: string | undefined): OpenCodeZenThinkingLevel {
  switch (level) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return level;
    case "max":
      return "xhigh";
    case "off":
    case "none":
    case undefined:
      return "minimal";
    default:
      return "minimal";
  }
}

function bindOpenCodeZenBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined || baseUrl.length === 0) {
    return OPENCODE_ZEN_BASE_URL;
  }
  if (baseUrl.endsWith("/chat/completions") || baseUrl.endsWith("/responses")) {
    return OPENCODE_ZEN_BASE_URL;
  }
  return baseUrl;
}

export function bindOpenCodeZenModel<T extends OpenCodeZenBindableModel>(model: T): T {
  if (!isOpenCodeZenProvider(model.provider)) {
    return model;
  }

  const museSpark = isOpenCodeZenMuseSparkModel(model.id);
  if (!museSpark) {
    if (model.provider === OPENCODE_PROVIDER) {
      return model;
    }
    return { ...model, provider: OPENCODE_PROVIDER };
  }

  return {
    ...model,
    provider: OPENCODE_PROVIDER,
    api: OPENCODE_ZEN_RESPONSES_API,
    baseUrl: bindOpenCodeZenBaseUrl(model.baseUrl),
    reasoning: true,
    thinkingLevelMap: {
      ...model.thinkingLevelMap,
      ...MUSE_SPARK_THINKING_LEVEL_MAP,
    },
  };
}
