import { API_BASE_URL } from "@/config";
import { settingsApi } from "./settings";
import { fetchWrapper } from "./fetchWrapper";

export type ProviderSource = "configured" | "local" | "builtin";

export interface PiModel {
  id: string;
  providerID: string;
  name: string;
  api: {
    id: string;
    url?: string;
    npm: string;
  };
  status: "active" | "deprecated";
  headers: Record<string, string>;
  options: Record<string, unknown>;
  cost: {
    input: number;
    output: number;
    cache?: {
      read: number;
      write: number;
    };
  };
  limit: {
    context: number;
    output: number;
  };
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    output: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
  };
  variants?: Record<string, Record<string, unknown>>;
}

export interface PiProvider {
  id: string;
  source: "custom" | "builtin";
  name: string;
  env: string[];
  options: Record<string, unknown>;
  models: Record<string, PiModel>;
}

export interface Model {
  id: string;
  key?: string;
  name: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context: number;
    output: number;
  };
  modalities?: {
    input: ("text" | "audio" | "image" | "video" | "pdf")[];
    output: ("text" | "audio" | "image" | "video" | "pdf")[];
  };
  experimental?: boolean;
  status?: "alpha" | "beta";
  options?: Record<string, unknown>;
  provider?: {
    npm: string;
  };
  variants?: Record<string, Record<string, unknown>>;
}

export interface Provider {
  id: string;
  name: string;
  api?: string;
  env: string[];
  npm?: string;
  models: Record<string, Model>;
  options?: Record<string, unknown>;
  source?: ProviderSource;
  isConnected?: boolean;
}

export type PiProviderApiType =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "mistral-conversations"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream";

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  api: PiProviderApiType;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader: boolean;
  models: Array<{
    id: string;
    name?: string;
    reasoning?: boolean;
    input?: ("text" | "image")[];
    contextWindow?: number;
    maxTokens?: number;
    cost?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
  }>;
  modelOverrides?: Record<string, unknown>;
}

export interface ProviderWithModels {
  id: string;
  name: string;
  api?: string;
  env: string[];
  npm?: string;
  models: Model[];
  source: ProviderSource;
  isConnected: boolean;
}

export interface ModelSelection {
  providerID: string;
  modelID: string;
}

export interface PiModelState {
  recent: ModelSelection[];
  favorite: ModelSelection[];
  variant: Record<string, string | undefined>;
}

interface ConfigProvider {
  npm?: string;
  name?: string;
  api?: string;
  options?: {
    baseURL?: string;
    [key: string]: unknown;
  };
  models?: Record<string, ConfigModel>;
}

interface ConfigModel {
  id?: string;
  name?: string;
  limit?: {
    context?: number;
    output?: number;
  };
  [key: string]: unknown;
}

const LOCAL_PROVIDER_IDS = ["ollama", "lmstudio", "llamacpp", "jan"];

function classifyProviderSource(providerId: string, isFromConfig: boolean): ProviderSource {
  if (!isFromConfig) return "builtin";
  if (LOCAL_PROVIDER_IDS.includes(providerId.toLowerCase())) return "local";
  return "configured";
}

const modelModalities = ["text", "audio", "image", "video", "pdf"] as const;

function enabledModalities(capabilities: Record<string, boolean> | undefined): ("text" | "audio" | "image" | "video" | "pdf")[] {
  if (!capabilities) return ["text"];
  return modelModalities.filter((modality) => capabilities[modality]);
}


interface PiProviderResponse {
  all: PiProvider[];
  connected: string[];
  default: Record<string, string>;
}

export interface ProvidersResult {
  providers: Provider[];
  connected: string[];
  default: Record<string, string>;
}

export async function getProviders(directory?: string): Promise<ProvidersResult> {
  try {
    const response = await fetchWrapper<PiProviderResponse>(`${API_BASE_URL}/api/provider`, {
      params: { directory },
    });

    if (response?.all && Array.isArray(response.all)) {
      const connectedSet = new Set(response.connected || []);

      const providers: Provider[] = response.all.map((piProvider: PiProvider) => {
        const models: Record<string, Model> = {};

        Object.entries(piProvider.models).forEach(([modelId, piModel]) => {
          const capabilities = piModel.capabilities;
          models[modelId] = {
            id: piModel.api?.id || piModel.id || modelId,
            key: modelId,
            name: piModel.name || piModel.id || modelId,
            attachment: capabilities?.attachment ?? capabilities?.input?.image ?? false,
            reasoning: capabilities?.reasoning ?? false,
            temperature: capabilities?.temperature ?? false,
            tool_call: capabilities?.toolcall ?? true,
            cost: {
              input: piModel.cost?.input ?? 0,
              output: piModel.cost?.output ?? 0,
              cache_read: piModel.cost?.cache?.read ?? 0,
              cache_write: piModel.cost?.cache?.write ?? 0,
            },
            limit: {
              context: piModel.limit?.context ?? 0,
              output: piModel.limit?.output ?? 0,
            },
            modalities: {
              input: enabledModalities(capabilities?.input),
              output: enabledModalities(capabilities?.output),
            },
            provider: {
              npm: piModel.api?.npm ?? "pi",
            },
            variants: piModel.variants,
          };
        });

        return {
          id: piProvider.id,
          name: piProvider.name,
          env: piProvider.env,
          source: piProvider.source === "custom" ? "configured" : "builtin",
          models,
          options: piProvider.options,
          isConnected: connectedSet.has(piProvider.id),
        };
      });

      return { providers, connected: response.connected || [], default: response.default || {} };
    }
  } catch {
    // Silently return empty providers on failure - graceful degradation
  }

  return { providers: [], connected: [], default: {} };
}

export async function getPiModelState(): Promise<PiModelState> {
  return await fetchWrapper<PiModelState>(`${API_BASE_URL}/api/providers/model-state`);
}

export async function addPiRecentModel(model: ModelSelection): Promise<PiModelState> {
  return await fetchWrapper<PiModelState>(`${API_BASE_URL}/api/providers/model-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recent: model }),
  });
}

export async function removePiRecentModel(model: ModelSelection): Promise<PiModelState> {
  return await fetchWrapper<PiModelState>(`${API_BASE_URL}/api/providers/model-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeRecent: model }),
  });
}

export async function togglePiFavoriteModel(model: ModelSelection): Promise<PiModelState> {
  return await fetchWrapper<PiModelState>(`${API_BASE_URL}/api/providers/model-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite: model }),
  });
}

async function getConfiguredProviders(connectedIds: Set<string>): Promise<ProviderWithModels[]> {
  try {
    const config = await settingsApi.getDefaultPiConfig();
    if (!config?.content?.provider) return [];

    const configProviders = config.content.provider as Record<string, ConfigProvider>;
    const result: ProviderWithModels[] = [];

    for (const [providerId, providerConfig] of Object.entries(configProviders)) {
      if (!providerConfig || typeof providerConfig !== "object") continue;

      const source = classifyProviderSource(providerId, true);
      const models: Model[] = [];

      if (providerConfig.models) {
        for (const [modelId, modelConfig] of Object.entries(providerConfig.models)) {
          if (!modelConfig || typeof modelConfig !== "object") continue;

          models.push({
            id: typeof modelConfig.id === 'string' ? modelConfig.id : modelId,
            key: modelId,
            name: modelConfig.name || modelId,
            limit: modelConfig.limit ? {
              context: modelConfig.limit.context || 0,
              output: modelConfig.limit.output || 0,
            } : undefined,
          });
        }
      }

      result.push({
        id: providerId,
        name: providerConfig.name || providerId,
        api: providerConfig.api || providerConfig.options?.baseURL,
        env: [],
        npm: providerConfig.npm,
        models,
        source,
        isConnected: connectedIds.has(providerId),
      });
    }

    return result;
  } catch {
    // Silently return empty providers on failure - graceful degradation
    return [];
  }
}

export async function getProvidersWithModels(directory?: string): Promise<ProviderWithModels[]> {
  const { providers: builtinProviders, connected } = await getProviders(directory);
  const connectedIds = new Set(connected);

  const configuredProviders = await getConfiguredProviders(connectedIds);
  const configuredIds = new Set(configuredProviders.map((p) => p.id));

  const builtinResult: ProviderWithModels[] = builtinProviders
    .filter((provider) => !configuredIds.has(provider.id))
    .map((provider) => {
      const models = Object.entries(provider.models || {}).map(([id, model]) => ({
        ...model,
        id: model.id || id,
        key: id,
        name: model.name || id,
      }));
      return {
        id: provider.id,
        name: provider.name,
        api: provider.api,
        env: provider.env || [],
        npm: provider.npm,
        models,
        source: provider.source ?? "builtin",
        isConnected: provider.isConnected ?? false,
      };
    });

  const allProviders = [...configuredProviders, ...builtinResult];

  allProviders.sort((a, b) => {
    if (a.isConnected !== b.isConnected) {
      return a.isConnected ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return allProviders;
}

export async function getModel(
  providerId: string,
  modelId: string,
  directory?: string,
): Promise<Model | null> {
  const providers = await getProvidersWithModels(directory);
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;

  return provider.models.find((m) => m.id === modelId) || null;
}

export function formatModelName(model: Model): string {
  return model.name || model.id;
}

export function formatProviderName(
  provider: Provider | ProviderWithModels,
): string {
  return provider.name || provider.id;
}

export const providerCredentialsApi = {
  list: async (): Promise<string[]> => {
    const { providers } = await fetchWrapper<{ providers: string[] }>(`${API_BASE_URL}/api/providers/credentials`);
    return providers;
  },

  getStatus: async (providerId: string): Promise<boolean> => {
    const { hasCredentials } = await fetchWrapper<{ hasCredentials: boolean }>(
      `${API_BASE_URL}/api/providers/${providerId}/credentials/status`
    );
    return hasCredentials;
  },

  set: async (providerId: string, apiKey: string): Promise<void> => {
    await fetchWrapper(`${API_BASE_URL}/api/providers/${providerId}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
  },

  delete: async (providerId: string): Promise<void> => {
    await fetchWrapper(`${API_BASE_URL}/api/providers/${providerId}/credentials`, {
      method: 'DELETE',
    });
  },
};

export const customProvidersApi = {
  list: async (): Promise<CustomProviderConfig[]> => {
    const { providers } = await fetchWrapper<{ providers: CustomProviderConfig[] }>(`${API_BASE_URL}/api/providers/custom`);
    return providers;
  },

  save: async (provider: CustomProviderConfig): Promise<CustomProviderConfig> => {
    const { provider: savedProvider } = await fetchWrapper<{ provider: CustomProviderConfig }>(`${API_BASE_URL}/api/providers/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(provider),
    });
    return savedProvider;
  },

  discoverModels: async (baseUrl: string, apiKey?: string): Promise<string[]> => {
    const { models } = await fetchWrapper<{ models: string[] }>(`${API_BASE_URL}/api/providers/custom/discover-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey }),
    });
    return models;
  },

  delete: async (providerId: string): Promise<void> => {
    await fetchWrapper(`${API_BASE_URL}/api/providers/custom/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
    });
  },
};
