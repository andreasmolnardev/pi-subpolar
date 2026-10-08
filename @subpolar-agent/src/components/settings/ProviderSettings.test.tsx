import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ProviderSettings } from './ProviderSettings'
import { providerLoginFlowApi, type ProviderLoginFlowStatus, type ProviderLoginEvent } from '@/api/oauth'

const { updateSettings } = vi.hoisted(() => ({ updateSettings: vi.fn() }))
vi.mock('@/hooks/useSettings', () => ({ useSettings: () => ({ preferences: {}, updateSettings }) }))
vi.mock('@/api/providers', () => ({
  getProviders: vi.fn(async () => ({ providers: [{ id: 'openai~personal', name: 'OpenAI (Personal)', isConnected: true,
      models: { 'gpt-test': { name: 'Test reasoning model', reasoning: true, limit: { context: 128000, output: 4096 } } },
    }], catalog: { providers: ['openai', 'openai-codex'].map((id) => ({
    id, name: id === 'openai' ? 'OpenAI' : 'OpenAI Codex', instances: [], models: [],
    authStatus: { state: 'unconfigured', configured: false },
    authMethods: [
      { kind: 'api_key', label: 'API key', available: true },
      { kind: 'subscription', label: id === 'openai' ? 'Sign in with ChatGPT' : 'Codex subscription', available: true },
    ],
  })) } })),
  customProvidersApi: { list: vi.fn(async () => []) },
  providerAccountsApi: { delete: vi.fn() },
}))
vi.mock('@/api/oauth', () => ({ providerLoginFlowApi: {
  start: vi.fn(), status: vi.fn(), events: vi.fn(), respond: vi.fn(), cancel: vi.fn(),
} }))

const pending: ProviderLoginFlowStatus = {
  flowId: 'chatgpt-flow', providerInstanceId: 'openai-codex', runtimeProviderId: 'openai-codex',
  type: 'oauth', phase: 'pending', createdAt: 1, updatedAt: 1, expiresAt: 999999,
}

async function openChatGPT(codex = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><ProviderSettings /></QueryClientProvider>)
  const tab = await screen.findByRole('tab', { name: 'Providers' })
  await userEvent.click(tab)
  if (codex) {
    const title = await screen.findByText('OpenAI Codex')
    const card = title.closest('[data-slot="card"]')!
    await userEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Add another account' }))
    await userEvent.click(screen.getByRole('button', { name: 'Codex subscription' }))
  } else {
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
  vi.mocked(providerLoginFlowApi.start).mockResolvedValue(pending)
  vi.mocked(providerLoginFlowApi.status).mockResolvedValue(pending)
  vi.mocked(providerLoginFlowApi.events).mockResolvedValue({ flowId: pending.flowId, events: [], nextSequence: 0 })
})
afterEach(cleanup)

describe('model/provider settings', () => {
  it('opens on the Providers tab', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><ProviderSettings /></QueryClientProvider>)
    expect(await screen.findByRole('tab', { name: 'Providers' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Default Models' })).toHaveAttribute('aria-selected', 'false')
  })

  it('persists account-qualified conversation and routing model defaults', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><ProviderSettings /></QueryClientProvider>)
    await userEvent.click(await screen.findByRole('tab', { name: 'Default Models' }))
    const selectors = await screen.findAllByRole('combobox')
    await userEvent.click(selectors[0]!)
    await userEvent.click(screen.getByRole('option', { name: /Test reasoning model/ }))
    expect(updateSettings).toHaveBeenCalledWith({ defaultModel: 'openai~personal/gpt-test' })
    await userEvent.click(selectors[1]!)
    await userEvent.click(screen.getByRole('option', { name: /Test reasoning model/ }))
    expect(updateSettings).toHaveBeenCalledWith({ defaultModels: { routing: 'openai~personal/gpt-test' } })
  })
})

describe('ChatGPT provider login', () => {
  it('uses the upstream ChatGPT label to start normal OpenAI OAuth, with an API key alternative', async () => {
    await openChatGPT()
    expect(screen.getByText(/This flow does not offer device code login/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Account label (optional)'), { target: { value: 'Direct' } })
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(providerLoginFlowApi.start).toHaveBeenCalledWith({ providerInstanceId: 'openai', type: 'oauth', displayName: 'Direct' })
  })

  it('keeps normal OpenAI API key login available beside ChatGPT sign-in', async () => {
    await openChatGPT()
    await userEvent.click(screen.getByRole('button', { name: 'API key' }))
    expect(screen.getByText(/Pi will securely ask for the API key/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(providerLoginFlowApi.start).toHaveBeenCalledWith({ providerInstanceId: 'openai', type: 'api_key' })
  })
  it('starts a separate openai-codex OAuth account with an optional label, not an OpenAI API key', async () => {
    await openChatGPT(true)
    expect(screen.getByText(/For a remote server or container/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Account label (optional)'), { target: { value: 'Personal' } })
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(providerLoginFlowApi.start).toHaveBeenCalledWith({
      providerInstanceId: 'openai-codex', type: 'oauth', displayName: 'Personal',
    }))
  })

  it('renders the native login-method selector and submits the device-code method id', async () => {
    vi.mocked(providerLoginFlowApi.status).mockResolvedValue({ ...pending, currentPrompt: {
      promptId: 'method', prompt: { type: 'select', message: 'Select OpenAI Codex login method:', options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device_code', label: 'Device code login (headless)' },
      ] },
    } })
    vi.mocked(providerLoginFlowApi.respond).mockResolvedValue(pending)
    await openChatGPT(true)
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await userEvent.click(await screen.findByRole('combobox'))
    await userEvent.click(screen.getByRole('option', { name: 'Device code login (headless)' }))
    await userEvent.click(screen.getByRole('button', { name: 'Submit response' }))
    expect(providerLoginFlowApi.respond).toHaveBeenCalledWith('chatgpt-flow', 'method', 'device_code')
  })

  it('renders device authorization and forwards a manual redirect fallback without showing tokens', async () => {
    const events: ProviderLoginEvent[] = [
      { sequence: 1, timestamp: 1, type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://auth.openai.com/codex/device' },
      { sequence: 2, timestamp: 1, type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize' },
    ]
    vi.mocked(providerLoginFlowApi.events).mockResolvedValue({ flowId: pending.flowId, events, nextSequence: 2 })
    vi.mocked(providerLoginFlowApi.status).mockResolvedValue({ ...pending, currentPrompt: {
      promptId: 'manual', prompt: { type: 'manual_code', message: 'Paste authorization code / redirect URL', placeholder: 'http://localhost:1455/auth/callback' },
    } })
    vi.mocked(providerLoginFlowApi.respond).mockResolvedValue({ ...pending, phase: 'completed' })
    await openChatGPT(true)
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open verification page' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open authorization page' })).toBeInTheDocument()
    const redirect = 'http://localhost:1455/auth/callback?code=test-code&state=test-state'
    fireEvent.change(screen.getByLabelText('Paste authorization code / redirect URL'), { target: { value: redirect } })
    await userEvent.click(screen.getByRole('button', { name: 'Submit response' }))
    expect(providerLoginFlowApi.respond).toHaveBeenCalledWith('chatgpt-flow', 'manual', redirect)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
