import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Model, Provider, Preferences } from '../../types/index.js'

const HOME = homedir()

export const STATE_DIR = join(HOME, '.openclaude-webui', 'state')
export const SESSIONS_DIR = join(STATE_DIR, 'sessions')
export const PREFERENCES_FILE = join(STATE_DIR, 'preferences.json')
export const MODELS_FILE = join(STATE_DIR, 'models.json')
export const AUTH_FILE = join(STATE_DIR, 'auth.json')
export const PROVIDER_KEYS_FILE = join(STATE_DIR, 'provider_keys.json')
export const ENV_FILE = join(HOME, '.env')

mkdirSync(SESSIONS_DIR, { recursive: true })

// ─── Proxy routing map — single source of truth ────────────────────────────
// All providers route through local Hono proxies that strip the Claude identity
// openclaude injects. Do NOT replace entries with direct provider base_urls.
export const PROXY_MAP: Record<string, string> = {
  openrouter: 'http://localhost:8789/or-proxy',
  venice: 'http://localhost:8789/venice-proxy',
  xai: 'http://localhost:8789/xai-proxy',
  groq: 'http://localhost:8789/groq-proxy',
  dolphin: 'http://localhost:8789/dolphin-proxy',
  nineteen: 'http://localhost:8789/nineteen-proxy',
}

export const PROVIDER_MAP: Record<string, { base_url: string; env_key: string }> = {
  anthropic: { base_url: 'https://api.anthropic.com/v1', env_key: 'ANTHROPIC_API_KEY' },
  openai: { base_url: 'https://api.openai.com/v1', env_key: 'OPENAI_API_KEY' },
  gemini: { base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', env_key: 'GEMINI_API_KEY' },
  mistral: { base_url: 'https://api.mistral.ai/v1', env_key: 'MISTRAL_API_KEY' },
  moonshot: { base_url: 'https://api.moonshot.ai/v1', env_key: 'MOONSHOT_API_KEY' },
  venice: { base_url: 'https://api.venice.ai/api/v1', env_key: 'VENICE_API_KEY' },
  openrouter: { base_url: 'https://openrouter.ai/api/v1', env_key: 'OPENROUTER_API_KEY' },
  xai: { base_url: 'https://api.x.ai/v1', env_key: 'XAI_API_KEY' },
  groq: { base_url: 'https://api.groq.com/openai/v1', env_key: 'GROQ_API_KEY' },
  dolphin: { base_url: 'https://chat.dolphin.ru/api/v1', env_key: 'DOLPHIN_API_KEY' },
  nineteen: { base_url: 'https://api.nineteen.ai/v1', env_key: 'NINETEEN_API_KEY' },
}

// Tool providers — no AI model routing, keys passed as env vars to the runner
export const TOOL_MAP: Record<string, { env_key: string; display_name: string }> = {
  apify: { env_key: 'APIFY_TOKEN', display_name: 'Apify' },
  firecrawl: { env_key: 'FIRECRAWL_API_KEY', display_name: 'Firecrawl' },
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  mistral: 'Mistral',
  moonshot: 'Moonshot',
  venice: 'Venice.ai',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  groq: 'Groq',
  dolphin: 'Dolphin',
  nineteen: 'Nineteen',
  apify: 'Apify',
  firecrawl: 'Firecrawl',
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
}

// ─── Env file ─────────────────────────────────────────────────────────────

export function readEnvFile(path = ENV_FILE): Record<string, string> {
  const env: Record<string, string> = {}
  if (!existsSync(path)) return env
  for (let line of readFileSync(path, 'utf-8').split('\n')) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7)
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    env[key] = val
  }
  return env
}

export function writeEnvFile(env: Record<string, string>): void {
  const lines = [
    '# OpenClaude Environment Configuration',
    '# Auto-updated by OpenClaude Web UI',
    '',
    ...Object.entries(env).map(([k, v]) => `export ${k}="${v}"`),
    '',
  ]
  writeFileSync(ENV_FILE, lines.join('\n'), 'utf-8')
}

// ─── Provider API keys ────────────────────────────────────────────────────

export function getProviderApiKey(provider: string): string | null {
  const keys = readJson<Record<string, string>>(PROVIDER_KEYS_FILE, {})
  if (keys[provider]) return keys[provider]
  const envKey = PROVIDER_MAP[provider]?.env_key
  if (envKey && process.env[envKey]) return process.env[envKey]!
  const env = readEnvFile()
  return env[envKey ?? ''] ?? null
}

export function setProviderApiKey(provider: string, apiKey: string): void {
  const keys = readJson<Record<string, string>>(PROVIDER_KEYS_FILE, {})
  keys[provider] = apiKey
  writeJson(PROVIDER_KEYS_FILE, keys)
}

export function getAllProviderKeys(): Record<string, string> {
  return readJson<Record<string, string>>(PROVIDER_KEYS_FILE, {})
}

// ─── Providers ────────────────────────────────────────────────────────────

export function getAllProviders(): Provider[] {
  const aiProviders = Object.entries(PROVIDER_MAP).map(([id, meta]) => ({
    id,
    name: PROVIDER_NAMES[id] ?? id,
    base_url: meta.base_url,
  }))
  const toolProviders = Object.entries(TOOL_MAP).map(([id, meta]) => ({
    id,
    name: meta.display_name,
    base_url: '',
  }))
  return [...aiProviders, ...toolProviders]
}

export function isToolProvider(provider: string): boolean {
  return provider in TOOL_MAP
}

// ─── Models ───────────────────────────────────────────────────────────────

export type ModelType = 'text' | 'image' | 'video' | 'audio' | 'music'

// Speech-to-text models (Whisper et al) need a file-upload UX, not text-in/audio-out.
// Detected separately so discovery can drop them before they reach the picker.
export function isAudioInputModel(modelId: string): boolean {
  return /whisper|transcrib|[._-]stt[._-]|[._-]stt$|^stt[._-]|speech[._-]to[._-]text|prompt[._-]guard|safeguard/i.test(modelId)
}

// Music / song-generation models — long-form audio (60s+). Routed via async
// queue+poll endpoints, not the sync /audio/speech path used for TTS. Checked
// before the audio (TTS) regex in inferModelType so music wins.
export function isMusicModel(modelId: string): boolean {
  return /ace[._-]step|minimax[._-]music|stable[._-]audio|mmaudio|elevenlabs[._-]music|sound[._-]effects/i.test(modelId)
}

export function inferModelType(modelId: string): ModelType {
  const id = modelId.toLowerCase()
  // Video checked first so "grok-imagine-video" doesn't match image pattern
  if (/video|mochi|wan[._-]|kling|cogvideo|animate|minimax[._-]vid/i.test(id)) return 'video'
  if (/flux|imagen|\bimage\b|imagine|stable[._-]diff|sdxl|hidream|aura|dall[._-]e|playground[._-]v|wai[._-]nsfw/i.test(id)) return 'image'
  // Music takes precedence over audio (TTS) since some patterns overlap (e.g. elevenlabs)
  if (isMusicModel(id)) return 'music'
  if (/orpheus|kokoro|elevenlabs|chatterbox|inworld|[\/._-]tts[\/._-]|[\/._-]tts$|^tts[\/._-]|speech|[\/._-]audio[\/._-]/i.test(id)) return 'audio'
  return 'text'
}

// Per-music-model body shape. Different music-gen APIs accept different keys —
// minimax v2 requires lyrics, v25/v26 require force_instrumental or lyrics, etc.
// `extra` is merged into the queue body verbatim. `reusePromptAsLyrics` reuses
// the user's prompt as `lyrics_prompt` for models that need it.
export interface MusicModelConfig {
  duration_seconds?: number     // pass `duration_seconds` (ace-step accepts it)
  format: 'mp3' | 'wav' | 'flac' | 'ogg'
  extra?: Record<string, unknown>
  reusePromptAsLyrics?: boolean
}

// Defaults aim at "give me a real song" — for minimax v25/v26 we default to
// instrumental so users don't have to write lyrics; v2 requires lyrics and has
// no instrumental flag, so the prompt doubles as the lyrics_prompt.
export const MUSIC_MODEL_DEFAULTS: Record<string, MusicModelConfig> = {
  'ace-step-15':                  { duration_seconds: 210, format: 'flac' },
  'minimax-music-v2':             { format: 'mp3', reusePromptAsLyrics: true },
  'minimax-music-v25':            { format: 'mp3', extra: { force_instrumental: true } },
  'minimax-music-v26':            { format: 'mp3', extra: { force_instrumental: true } },
  'stable-audio-25':              { format: 'mp3' },
  'mmaudio-v2-text-to-audio':     { format: 'mp3' },
  'elevenlabs-music':             { format: 'mp3' },
  'elevenlabs-sound-effects-v2':  { format: 'mp3' },
}

// Per-provider audio (TTS) defaults. Endpoint is the OpenAI-compat speech path
// for providers that support it; voice is the safest default per provider.
export interface AudioProviderConfig {
  endpoint: string             // path appended to provider base_url (e.g. "/audio/speech")
  voice: string                // default voice identifier
  format: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm'
  base_url_override?: string   // when not OpenAI-compat or path differs from base_url
}

export const AUDIO_PROVIDER_DEFAULTS: Record<string, AudioProviderConfig> = {
  openai: { endpoint: '/audio/speech', voice: 'alloy', format: 'mp3' },
  groq:   { endpoint: '/audio/speech', voice: 'tara',  format: 'wav' },
  venice: { endpoint: '/audio/speech', voice: 'af_sky', format: 'mp3' },
}

export function getConfiguredModels(): Model[] {
  const data = readJson<Record<string, ModelEntry>>(MODELS_FILE, {})
  return Object.entries(data).map(([id, meta]) => ({
    id,
    model: meta.model ?? (id.includes('/') ? id.split('/').slice(1).join('/') : id),
    alias: meta.alias ?? id,
    provider: meta.provider ?? (id.includes('/') ? id.split('/')[0] : 'unknown'),
    type: meta.type ?? inferModelType(id),
  }))
}

export function getModelsByProvider(provider: string): Model[] {
  return getConfiguredModels().filter((m) => m.provider === provider)
}

export interface ModelCapabilities {
  tools?: boolean     // model supports tool/function calling (default: true)
  thinking?: boolean  // model supports reasoning/thinking mode (default: false)
  vision?: boolean    // model supports image inputs (default: false)
}

export interface ModelEntry {
  provider: string
  model: string
  alias: string
  context_window?: number
  capabilities?: ModelCapabilities
  type?: ModelType  // when set by discovery, overrides regex inference
}

export function getModelEntry(modelId: string): ModelEntry | null {
  const data = readJson<Record<string, ModelEntry>>(MODELS_FILE, {})
  return data[modelId] ?? null
}

export function addModelEntry(
  modelId: string,
  provider: string,
  model: string,
  alias: string
): void {
  const data = readJson<Record<string, unknown>>(MODELS_FILE, {})
  data[modelId] = { provider, model, alias, base_url: '' }
  writeJson(MODELS_FILE, data)
}

export function saveModels(
  models: Array<{ id: string; provider: string; model: string; alias: string; context_window?: number; type?: ModelType }>,
  provider: string
): void {
  const data = readJson<Record<string, unknown>>(MODELS_FILE, {})
  // Remove old entries for this provider
  for (const key of Object.keys(data)) {
    if ((data[key] as Record<string, string>)?.provider === provider) delete data[key]
  }
  for (const m of models) {
    const entry: Record<string, unknown> = { provider: m.provider, model: m.model, alias: m.alias, base_url: '' }
    if (m.context_window) entry['context_window'] = m.context_window
    if (m.type) entry['type'] = m.type
    data[m.id] = entry
  }
  writeJson(MODELS_FILE, data)
}

// ─── Preferences ──────────────────────────────────────────────────────────

export function loadPreferences(): Preferences {
  const prefs = readJson<Partial<Preferences>>(PREFERENCES_FILE, {})
  if (!prefs.default_model_id) {
    const env = readEnvFile()
    const model = env['OPENAI_MODEL'] ?? ''
    const baseUrl = env['OPENAI_BASE_URL'] ?? ''
    let provider = ''
    if (baseUrl.includes('venice')) provider = 'venice'
    else if (baseUrl.includes('openrouter')) provider = 'openrouter'
    else if (baseUrl.includes('x.ai')) provider = 'xai'
    return {
      theme: 'dark',
      default_provider: provider,
      default_model: model,
      default_model_id: provider && model ? `${provider}/${model}` : model,
    }
  }
  return { theme: 'dark', ...prefs } as Preferences
}

export function savePreferences(prefs: Partial<Preferences>): void {
  const current = loadPreferences()
  writeJson(PREFERENCES_FILE, { ...current, ...prefs })
}

export function getCurrentPrimaryModel(): string {
  return loadPreferences().default_model_id ?? ''
}

// ─── Auth ─────────────────────────────────────────────────────────────────

export function getAuthToken(): string {
  const data = readJson<{ token?: string }>(AUTH_FILE, {})
  return data.token ?? ''
}

// ─── Cost estimation ──────────────────────────────────────────────────────

const COST_MAP: Array<[string, number, number]> = [
  ['kimi-k2', 2.0, 8.0],
  ['grok-3', 3.0, 15.0],
  ['grok-4', 5.0, 20.0],
  ['llama-4-maverick', 0.2, 0.8],
  ['gemma', 0.4, 1.6],
  ['deepseek', 0.5, 2.0],
  ['claude', 3.0, 15.0],
]

export function getModelCost(modelId: string): { input_per_m: number; output_per_m: number } {
  const lower = modelId.toLowerCase()
  for (const [key, inp, out] of COST_MAP) {
    if (lower.includes(key)) return { input_per_m: inp, output_per_m: out }
  }
  return { input_per_m: 1.0, output_per_m: 4.0 }
}
