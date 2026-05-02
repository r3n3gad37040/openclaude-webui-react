import {
  PROVIDER_MAP,
  PROXY_MAP,
  getProviderApiKey,
  setProviderApiKey,
  getModelEntry,
  addModelEntry,
  loadPreferences,
  savePreferences,
  readEnvFile,
  writeEnvFile,
  getAllProviders,
  getConfiguredModels,
  saveModels,
  isToolProvider,
  isAudioInputModel,
} from './config.js'
import type { Model, ModelType } from '../../types/index.js'

// ─── Discovery ────────────────────────────────────────────────────────────

// type is optional during discovery — when omitted, getConfiguredModels falls back to regex inference
type ModelWithContext = Omit<Model, 'type'> & { type?: Model['type']; context_window?: number }

interface RawModel {
  id: string
  name?: string
  context_length?: number
  max_context_length?: number
}

async function fetchType(url: string, apiKey: string, provider: string, type?: ModelType): Promise<ModelWithContext[]> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: RawModel[] }
    return (data.data ?? []).map((m) => ({
      id: `${provider}/${m.id}`,
      model: m.id,
      alias: m.name ?? m.id,
      provider,
      ...(type ? { type } : {}),
      context_window: m.context_length ?? m.max_context_length,
    }))
  } catch {
    return []
  }
}

async function fetchAnthropicModels(apiKey: string): Promise<ModelWithContext[]> {
  // Anthropic uses x-api-key + anthropic-version headers, and returns
  // {data: [{id, display_name, max_input_tokens}]} — different from OpenAI shape.
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string; max_input_tokens?: number }> }
    return (data.data ?? []).map((m) => ({
      id: `anthropic/${m.id}`,
      model: m.id,
      alias: m.display_name ?? m.id,
      provider: 'anthropic',
      type: 'text' as const,
      context_window: m.max_input_tokens,
    }))
  } catch {
    return []
  }
}

async function fetchProviderModels(provider: string, apiKey: string): Promise<ModelWithContext[]> {
  const meta = PROVIDER_MAP[provider]
  if (!meta) return []

  if (provider === 'anthropic') return fetchAnthropicModels(apiKey)

  // Venice exposes models per type via ?type=text|image|video|tts|music. The default returns
  // text only — every non-text class needs its own call. tts and music both render as 'audio'
  // in our type system; routing later distinguishes by isMusicModel().
  if (provider === 'venice') {
    const [text, image, video, tts, music] = await Promise.all([
      fetchType(`${meta.base_url}/models?type=text`, apiKey, provider, 'text'),
      fetchType(`${meta.base_url}/models?type=image`, apiKey, provider, 'image'),
      fetchType(`${meta.base_url}/models?type=video`, apiKey, provider, 'video'),
      fetchType(`${meta.base_url}/models?type=tts`, apiKey, provider, 'audio'),
      fetchType(`${meta.base_url}/models?type=music`, apiKey, provider, 'music'),
    ])
    // Dedup: tts + music endpoints can return overlapping models. Process music
    // BEFORE tts so the tts classification wins for ids returned by both.
    const byId = new Map<string, typeof text[number]>()
    for (const m of [...text, ...image, ...video, ...music, ...tts]) byId.set(m.id, m)
    // Force-reclassify any id that looks like TTS but only appeared under
    // ?type=music (Venice puts elevenlabs-tts-v3 / -multilingual-v2 there).
    for (const m of byId.values()) {
      if (m.type === 'music' && /[\/._-]tts[\/._-]|[\/._-]tts$|^tts[\/._-]/i.test(m.id)) {
        m.type = 'audio'
      }
    }
    return [...byId.values()]
  }

  return fetchType(`${meta.base_url}/models`, apiKey, provider)
}

export async function discoverAndSaveModels(
  provider: string,
  apiKey?: string | null
): Promise<Model[]> {
  if (isToolProvider(provider)) return []

  const key = apiKey ?? getProviderApiKey(provider)
  if (!key) return []

  const raw = await fetchProviderModels(provider, key)
  // Drop STT / classifier models — they need a file-upload UX we don't have.
  // Surfacing them in the chat-model picker just produces broken sessions.
  const models = raw.filter((m) => !isAudioInputModel(m.id) && !isAudioInputModel(m.model))
  if (models.length > 0) {
    saveModels(models, provider)
  }
  return models
}

// ─── Switching ────────────────────────────────────────────────────────────

export interface SwitchResult {
  status: 'ok' | 'error'
  provider?: string
  model?: string
  model_id?: string
  error?: string
}

export async function switchModel(
  provider: string,
  model: string,
  apiKey?: string | null,
  discover = false
): Promise<SwitchResult> {
  if (isToolProvider(provider)) {
    return { status: 'error', error: `${provider} is a tool provider, not an AI model provider` }
  }
  const meta = PROVIDER_MAP[provider]
  if (!meta) return { status: 'error', error: `Unknown provider: ${provider}` }

  const resolvedKey = apiKey ?? getProviderApiKey(provider)
  if (!resolvedKey) {
    return { status: 'error', error: `No API key available for provider: ${provider}` }
  }

  if (apiKey) setProviderApiKey(provider, apiKey)
  if (discover) await discoverAndSaveModels(provider, resolvedKey)

  const modelId = `${provider}/${model}`

  if (!getModelEntry(modelId)) {
    addModelEntry(modelId, provider, model, model)
  }

  // Update ~/.env
  const env = readEnvFile()
  // All providers route through local proxies for Claude-identity stripping.
  // Use the shared PROXY_MAP as the single source of truth.
  env['OPENAI_BASE_URL'] = PROXY_MAP[provider] ?? meta.base_url
  env['OPENAI_MODEL'] = model
  env['CLAUDE_CODE_USE_OPENAI'] = '1'
  env['OPENAI_API_KEY'] = resolvedKey

  if (provider === 'venice') {
    env['VENICE_MODEL_NAME'] = model
    env['VENICE_UNCENSORED'] = 'true'
  } else {
    delete env['VENICE_MODEL_NAME']
    delete env['VENICE_UNCENSORED']
  }

  const providerEnvKeys: Record<string, string> = {
    venice: 'VENICE_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    xai: 'XAI_API_KEY',
    groq: 'GROQ_API_KEY',
  }
  const envKeyName = providerEnvKeys[provider]
  if (envKeyName) env[envKeyName] = resolvedKey

  writeEnvFile(env)

  // Update preferences
  const prefs = loadPreferences()
  prefs.default_provider = provider
  prefs.default_model = model
  prefs.default_model_id = modelId
  savePreferences(prefs)

  return { status: 'ok', provider, model, model_id: modelId }
}

// ─── Info ─────────────────────────────────────────────────────────────────

export function getModelInfo() {
  const prefs = loadPreferences()
  return {
    current_model_id: prefs.default_model_id,
    current_provider: prefs.default_provider,
    current_model: prefs.default_model,
    models: getConfiguredModels().map((m) => ({
      id: m.id,
      alias: m.alias,
      provider: m.provider,
      model: m.model,
    })),
    providers: getAllProviders(),
  }
}
