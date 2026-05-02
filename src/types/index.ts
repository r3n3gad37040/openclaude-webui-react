// ─── Core domain types shared between frontend and backend ───────────────

export interface Provider {
  id: string
  name: string
  base_url: string
}

export type ModelType = 'text' | 'image' | 'video' | 'audio' | 'music'

export interface Model {
  id: string          // "venice/kimi-k2-5"
  model: string       // "kimi-k2-5"
  alias: string       // "Kimi K2.5"
  provider: string    // "venice"
  type: ModelType
}

export interface ToolCall {
  tool_id: string
  name: string
  input: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  attachments?: Attachment[]
  generated_media?: GeneratedMedia[]
  input_tokens?: number
  output_tokens?: number
  estimated_cost?: number
  tool_calls?: ToolCall[]
}

export type TemperaturePreset = 'precise' | 'balanced' | 'creative'

export interface Session {
  id: string
  title: string
  model_id: string
  created_at: string
  updated_at: string
  messages: Message[]
  system_prompt?: string
  temperature_preset?: TemperaturePreset
}

export interface SessionSummary {
  id: string
  title: string
  model_id: string
  created_at: string
  updated_at: string
  message_count: number
}

export interface Attachment {
  name: string
  path: string
  size: number
  extracted_text?: string
}

export interface GeneratedMedia {
  url: string          // resolved URL suitable for <img src>, <video src>, or <audio src>
  media_type: 'image' | 'video' | 'audio'
  alt?: string         // alt text / description
  width?: number
  height?: number
}

export interface ProviderKey {
  has_key: boolean
  last4: string
}

export interface ProviderStatus {
  id: string
  name: string
  key_status: 'green' | 'red'
}

export interface AppStatus {
  model: string
  providers: ProviderStatus[]
  session_count: number
  active_runners: Record<string, boolean>
  total_input_tokens: number
  total_output_tokens: number
  total_cost: number
}

export interface ModelInfo {
  current_model_id: string
  current_provider: string
  current_model: string
  models: Model[]
  providers: Provider[]
}

// ─── SSE event types ──────────────────────────────────────────────────────

export type SSEEvent =
  | { type: 'chunk'; content: string }
  | { type: 'error'; content: string }
  | { type: 'usage'; data: { input_tokens: number; output_tokens: number } }
  | { type: 'tool_start'; name: string; tool_id: string }
  | { type: 'tool_done'; name: string; tool_id: string; input: string }
  | { type: 'media'; url: string; media_type: 'image' | 'video' | 'audio'; alt?: string; width?: number; height?: number }
  | { type: 'done' }

// ─── API response shapes ──────────────────────────────────────────────────

export interface SwitchModelRequest {
  provider: string
  model: string
  api_key?: string
  discover?: boolean
  session_id?: string
}

export interface SwitchModelResponse {
  status: 'ok' | 'error'
  provider?: string
  model?: string
  model_id?: string
  error?: string
}

export interface DiscoverModelsResponse {
  status: 'ok' | 'error'
  provider: string
  count: number
  models: Model[]
  error?: string
}

export interface SendMessageRequest {
  message: string
  attachments?: Array<{ name: string; path: string; size: number }>
}

export type Theme = 'dark' | 'amoled' | 'gruvbox' | 'nord' | 'solarized'

export interface Preferences {
  theme: Theme
  default_provider: string
  default_model: string
  default_model_id: string
  default_system_prompt?: string
  default_temperature_preset?: TemperaturePreset
}
