import type {
  Message,
  Model,
  Provider,
  ProviderStatus,
  AppStatus,
  ModelInfo,
  DiscoverModelsResponse,
  SwitchModelResponse,
} from '../../types/index.js'

const API_BASE = '/api'

async function fetchAPI<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (res.status === 401) {
    throw new Error('Unauthorized')
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// ─── Sessions ─────────────────────────────────────────────────────────────

export async function listSessions() {
  return fetchAPI<Array<{ id: string; title: string; model_id: string; created_at: string; updated_at: string; message_count: number }>>('/sessions')
}

export async function createSession(): Promise<{ id: string }> {
  return fetchAPI('/sessions', { method: 'POST' })
}

export async function deleteSession(id: string): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' })
  return res.json()
}

export async function renameSession(id: string, title: string): Promise<{ status: string }> {
  return fetchAPI(`/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export async function getSession(id: string): Promise<{ id: string; title: string; model_id: string; messages: Message[]; created_at: string; updated_at: string }> {
  return fetchAPI(`/sessions/${id}`)
}

export async function regenerateResponse(sessionId: string) {
  return fetch(`${API_BASE}/messages/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  })
}

// ─── Messages ─────────────────────────────────────────────────────────────

export async function sendMessage(sessionId: string, message: string, attachments?: Array<{ name: string; path: string; size: number }>) {
  return fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, attachments }),
  })
}

export async function cancelMessage(sessionId: string): Promise<{ status: string }> {
  return fetchAPI(`/sessions/${sessionId}/cancel`, { method: 'POST' })
}

// ─── Models & Providers ──────────────────────────────────────────────────

export async function getModels(): Promise<{ models: Model[]; current: string; current_model: string; current_provider: string }> {
  return fetchAPI('/models')
}

export async function getModelInfo(): Promise<ModelInfo> {
  return fetchAPI('/model')
}

export async function getProviders(): Promise<{ providers: Provider[] }> {
  return fetchAPI('/providers')
}

export async function switchModel(
  provider: string,
  model: string,
  api_key?: string,
  discover?: boolean,
  session_id?: string,
): Promise<SwitchModelResponse> {
  return fetchAPI('/switch-model', {
    method: 'POST',
    body: JSON.stringify({ provider, model, api_key, discover, session_id }),
  })
}

export async function discoverModels(provider: string, api_key?: string): Promise<DiscoverModelsResponse> {
  return fetchAPI('/discover-models', {
    method: 'POST',
    body: JSON.stringify({ provider, api_key }),
  })
}

export async function getProviderKeys(): Promise<{ keys: Record<string, { has_key: boolean; last4: string }> }> {
  return fetchAPI('/provider_keys')
}

export async function setProviderKey(provider: string, api_key: string): Promise<{ status: string }> {
  return fetchAPI('/provider_keys', {
    method: 'POST',
    body: JSON.stringify({ provider, api_key }),
  })
}

export async function deleteProviderKey(provider: string): Promise<{ status: string }> {
  return fetchAPI(`/provider_keys/${provider}`, { method: 'DELETE' })
}

// ─── Status & Preferences ────────────────────────────────────────────────

export async function getStatus(): Promise<AppStatus> {
  return fetchAPI('/status')
}

export async function getThemes(): Promise<{ themes: Array<{ id: string; name: string }> }> {
  return fetchAPI('/themes')
}

export async function getPreferences(): Promise<{ default_system_prompt: string; default_temperature_preset: string | null }> {
  return fetchAPI('/preferences')
}

export async function savePreferences(prefs: Record<string, unknown>): Promise<{ status: string }> {
  return fetchAPI('/preferences', {
    method: 'POST',
    body: JSON.stringify(prefs),
  })
}

export async function restartServer(): Promise<{ status: string; message: string }> {
  return fetchAPI('/restart', { method: 'POST' })
}

export async function auth(token: string): Promise<{ ok: boolean; token: string }> {
  return fetchAPI('/auth', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

// ─── Media ────────────────────────────────────────────────────────────────

export function mediaUrl(path: string): string {
  return `${API_BASE}/media/serve?path=${encodeURIComponent(path)}`
}
