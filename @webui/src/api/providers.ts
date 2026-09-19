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

export type ProviderAuthMethodKind = 'api_key' | 'oauth' | 'subscription';
export type ProviderAuthState = 'authenticated' | 'expired' | 'unconfigured' | 'error' | 'unknown';

export interface ProviderAuthStatus {
  state: ProviderAuthState;
  configured: boolean;
  method?: ProviderAuthMethodKind;
  source?: string;
  label?: string;
}

export interface ProviderAuthMethod {
  kind: ProviderAuthMethodKind;
  label: string;
  available: boolean;
  status: ProviderAuthStatus;
}

/** Sanitized provider account instance. Credential material is never part of this type. */
export interface ProviderInstance {
  id: string;
  instanceId: string;
  providerId: string;
  label: string;
  email?: string;
  source: 'runtime' | 'pocketbase';
  authMethod?: ProviderAuthMethodKind;
  status: ProviderAuthStatus;
}

export interface ProviderCatalogModel {
  id: string;
  instanceId: string;
  providerId: string;
  modelId: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: readonly ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderCatalogProvider {
  id: string;
  name: string;
  source: 'runtime' | 'pocketbase' | 'mixed';
  authMethods: readonly ProviderAuthMethod[];
  authStatus: ProviderAuthStatus;
  instances: readonly ProviderInstance[];
  models: readonly ProviderCatalogModel[];
}

export interface ProviderCatalog {
  providers: readonly ProviderCatalogProvider[];
  accounts: readonly ProviderInstance[];
  models: readonly ProviderCatalogModel[];
}

// Names mirror the canonical server DTOs while the shorter aliases remain convenient in UI code.
export type ProviderAuthStatusDto = ProviderAuthStatus;
export type ProviderAuthMethodDto = ProviderAuthMethod;
export type ProviderAccountDto = ProviderInstance;
export type ProviderModelDto = ProviderCatalogModel;
export type ProviderCatalogProviderDto = ProviderCatalogProvider;
export type ProviderCatalogDto = ProviderCatalog;

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


function catalogProviderToLegacyProviders(catalog: ProviderCatalog): Provider[] {
  const providers: Provider[] = [];

  for (const provider of catalog.providers) {
    const instances = provider.instances.length > 0
      ? provider.instances
      : [{
          id: provider.id,
          instanceId: provider.id,
          providerId: provider.id,
          label: provider.name,
          source: 'runtime' as const,
          status: provider.authStatus,
        }];

    for (const instance of instances) {
      const models: Record<string, Model> = {};
      for (const catalogModel of provider.models.filter((model) => model.instanceId === instance.instanceId)) {
        models[catalogModel.modelId] = {
          id: catalogModel.modelId,
          key: catalogModel.modelId,
          name: catalogModel.name,
          attachment: catalogModel.input.includes('image'),
          reasoning: catalogModel.reasoning,
          tool_call: true,
          cost: {
            input: catalogModel.cost.input,
            output: catalogModel.cost.output,
            cache_read: catalogModel.cost.cacheRead,
            cache_write: catalogModel.cost.cacheWrite,
          },
          limit: { context: catalogModel.contextWindow, output: catalogModel.maxTokens },
          modalities: { input: [...catalogModel.input], output: ['text'] },
        };
      }

      const displayName = instances.length > 1 || instance.instanceId !== provider.id
        ? `${provider.name} · ${instance.label}`
        : provider.name;
      providers.push({
        id: instance.instanceId,
        name: displayName,
        env: [],
        models,
        source: provider.source === 'pocketbase' ? 'configured' : 'builtin',
        isConnected: instance.status.configured,
      });
    }
  }

  return providers;
}

export async function getProviderCatalog(directory?: string): Promise<ProviderCatalog> {
  const response = await fetchWrapper<ProviderCatalog | { catalog: ProviderCatalog }>(`${API_BASE_URL}/api/providers/catalog`, {
    params: { directory },
  });
  return 'catalog' in response ? response.catalog : response;
}

export const providerCatalogApi = {
  get: getProviderCatalog,
};

export interface ProvidersResult {
  providers: Provider[];
  connected: string[];
  default: Record<string, string>;
  catalog?: ProviderCatalog;
}

export async function getProviders(directory?: string): Promise<ProvidersResult> {
  try {
    const catalog = await getProviderCatalog(directory);
    const providers = catalogProviderToLegacyProviders(catalog);
    return {
      providers,
      connected: providers.filter((provider) => provider.isConnected).map((provider) => provider.id),
      default: {},
      catalog,
    };
  } catch {
    // Keep model selectors usable when the catalog endpoint is unavailable.
    return { providers: [], connected: [], default: {} };
  }
}

export interface ProviderAccountUpdate {
  displayName?: string;
  status?: 'active' | 'disabled';
}

export interface ProviderAccountStatus {
  instanceId: string;
  providerType: string;
  authType: 'api_key' | 'oauth';
  status: 'active' | 'disabled';
  hasCredential: boolean;
  credentialExpiresAt?: number;
  lastUsedAt?: number;
  configured: boolean;
  expired: boolean;
}

/** Account-instance operations. These endpoints return sanitized metadata only. */
export const providerAccountsApi = {
  list: async (): Promise<ProviderInstance[]> => {
    const response = await fetchWrapper<ProviderInstance[] | { accounts: ProviderInstance[] }>(`${API_BASE_URL}/api/providers/accounts`);
    return Array.isArray(response) ? response : response.accounts;
  },

  get: async (instanceId: string): Promise<ProviderInstance | null> => {
    const response = await fetchWrapper<ProviderInstance | { account?: ProviderInstance }>(
      `${API_BASE_URL}/api/providers/accounts/${encodeURIComponent(instanceId)}`,
    );
    return 'account' in response ? response.account ?? null : response as ProviderInstance;
  },

  status: async (instanceId: string): Promise<ProviderAccountStatus | null> => {
    const response = await fetchWrapper<ProviderAccountStatus | { status?: ProviderAccountStatus }>(
      `${API_BASE_URL}/api/providers/accounts/${encodeURIComponent(instanceId)}/status`,
    );
    return 'status' in response && typeof response.status === 'object' ? response.status ?? null : response as ProviderAccountStatus;
  },

  update: async (instanceId: string, input: ProviderAccountUpdate): Promise<ProviderInstance> => {
    const response = await fetchWrapper<ProviderInstance | { account: ProviderInstance }>(
      `${API_BASE_URL}/api/providers/accounts/${encodeURIComponent(instanceId)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    );
    return 'account' in response ? response.account : response;
  },

  delete: async (instanceId: string): Promise<void> => {
    await fetchWrapper(`${API_BASE_URL}/api/providers/accounts/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
  },
};

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
