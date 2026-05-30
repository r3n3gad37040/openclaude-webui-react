import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
const HOME = homedir();
export const STATE_DIR = join(HOME, '.openclaude-webui', 'state');
export const SESSIONS_DIR = join(STATE_DIR, 'sessions');
export const PREFERENCES_FILE = join(STATE_DIR, 'preferences.json');
export const MODELS_FILE = join(STATE_DIR, 'models.json');
export const AUTH_FILE = join(STATE_DIR, 'auth.json');
export const PROVIDER_KEYS_FILE = join(STATE_DIR, 'provider_keys.json');
export const ENV_FILE = join(HOME, '.env');
mkdirSync(SESSIONS_DIR, { recursive: true });
// ─── Proxy routing map — single source of truth ────────────────────────────
// All providers route through local Hono proxies that strip the Claude identity
// openclaude injects. Do NOT replace entries with direct provider base_urls.
// Built dynamically from PORT so changing the API port doesn't strand
// openclaude pointing at the wrong place.
const API_PORT = parseInt(process.env['PORT'] ?? '8789');
const PROXY_BASE = `http://localhost:${API_PORT}`;
export const PROXY_MAP = {
    anthropic: `${PROXY_BASE}/anthropic-proxy`,
    openrouter: `${PROXY_BASE}/or-proxy`,
    venice: `${PROXY_BASE}/venice-proxy`,
    xai: `${PROXY_BASE}/xai-proxy`,
    groq: `${PROXY_BASE}/groq-proxy`,
    dolphin: `${PROXY_BASE}/dolphin-proxy`,
    nineteen: `${PROXY_BASE}/nineteen-proxy`,
};
export const PROVIDER_MAP = {
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
};
// Tool providers — no AI model routing, keys passed as env vars to the runner
export const TOOL_MAP = {
    apify: { env_key: 'APIFY_TOKEN', display_name: 'Apify' },
    firecrawl: { env_key: 'FIRECRAWL_API_KEY', display_name: 'Firecrawl' },
};
const PROVIDER_NAMES = {
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
};
function readJson(path, fallback) {
    if (!existsSync(path))
        return fallback;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch (err) {
        process.stderr.write(`[config] readJson(${path}) parse failed: ${err}\n`);
        return fallback;
    }
}
// Atomic JSON write: tmp + rename so a kill-during-write leaves the
// previous valid file in place rather than a half-written one. Sync API
// here because callers are infrequent (key rotation, prefs save) and the
// surrounding code is sync.
function writeJson(path, data) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, path);
}
// ─── Env file ─────────────────────────────────────────────────────────────
export function readEnvFile(path = ENV_FILE) {
    const env = {};
    if (!existsSync(path))
        return env;
    for (let line of readFileSync(path, 'utf-8').split('\n')) {
        line = line.trim();
        if (!line || line.startsWith('#'))
            continue;
        if (line.startsWith('export '))
            line = line.slice(7);
        const eq = line.indexOf('=');
        if (eq === -1)
            continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        env[key] = val;
    }
    return env;
}
// Quote a value for safe inclusion in a shell-sourced file. Single-quoting
// disables every shell metachar except `'` itself, which we escape by
// closing-quoting-escaping-reopening: `'\''`. Using single quotes (rather
// than double) means we don't have to worry about $, `, \, !, etc.
function shellEscape(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function writeEnvFile(env) {
    const lines = [
        '# OpenClaude Environment Configuration',
        '# Auto-updated by OpenClaude Web UI',
        '',
        ...Object.entries(env).map(([k, v]) => `export ${k}=${shellEscape(v)}`),
        '',
    ];
    writeFileSync(ENV_FILE, lines.join('\n'), 'utf-8');
}
// ─── Provider API keys ────────────────────────────────────────────────────
export function getProviderApiKey(provider) {
    const keys = readJson(PROVIDER_KEYS_FILE, {});
    if (keys[provider])
        return keys[provider];
    const envKey = PROVIDER_MAP[provider]?.env_key;
    if (envKey && process.env[envKey])
        return process.env[envKey];
    const env = readEnvFile();
    return env[envKey ?? ''] ?? null;
}
export function setProviderApiKey(provider, apiKey) {
    const keys = readJson(PROVIDER_KEYS_FILE, {});
    keys[provider] = apiKey;
    writeJson(PROVIDER_KEYS_FILE, keys);
}
export function getAllProviderKeys() {
    return readJson(PROVIDER_KEYS_FILE, {});
}
// ─── Providers ────────────────────────────────────────────────────────────
export function getAllProviders() {
    const aiProviders = Object.entries(PROVIDER_MAP).map(([id, meta]) => ({
        id,
        name: PROVIDER_NAMES[id] ?? id,
        base_url: meta.base_url,
    }));
    const toolProviders = Object.entries(TOOL_MAP).map(([id, meta]) => ({
        id,
        name: meta.display_name,
        base_url: '',
    }));
    return [...aiProviders, ...toolProviders];
}
export function isToolProvider(provider) {
    return provider in TOOL_MAP;
}
// Speech-to-text models (Whisper et al) need a file-upload UX, not text-in/audio-out.
// Detected separately so discovery can drop them before they reach the picker.
export function isAudioInputModel(modelId) {
    return /whisper|transcrib|[._-]stt[._-]|[._-]stt$|^stt[._-]|speech[._-]to[._-]text|prompt[._-]guard|safeguard/i.test(modelId);
}
// Music / song-generation models — long-form audio (60s+). Routed via async
// queue+poll endpoints, not the sync /audio/speech path used for TTS. Checked
// before the audio (TTS) regex in inferModelType so music wins.
export function isMusicModel(modelId) {
    return /ace[._-]step|minimax[._-]music|stable[._-]audio|mmaudio|elevenlabs[._-]music|sound[._-]effects/i.test(modelId);
}
export function inferModelType(modelId) {
    const id = modelId.toLowerCase();
    // Video checked first so "grok-imagine-video" doesn't match image pattern
    if (/video|mochi|wan[._-]|kling|cogvideo|animate|minimax[._-]vid|veo|sora|pixverse|vidu|topaz.*video|ltx.*video|longcat.*video|happyhorse|seedance|ovi.*video/i.test(id))
        return 'video';
    if (/flux|imagen|\bimage\b|imagine|stable[._-]diff|sdxl|hidream|aura|dall[._-]e|playground[._-]v|wai[._-]nsfw/i.test(id))
        return 'image';
    // Music takes precedence over audio (TTS) since some patterns overlap (e.g. elevenlabs)
    if (isMusicModel(id))
        return 'music';
    if (/orpheus|kokoro|elevenlabs|chatterbox|inworld|[\/._-]tts[\/._-]|[\/._-]tts$|^tts[\/._-]|speech|[\/._-]audio[\/._-]/i.test(id))
        return 'audio';
    return 'text';
}
// Defaults aim at "give me a real song" — for minimax v25/v26 we default to
// instrumental so users don't have to write lyrics; v2 requires lyrics and has
// no instrumental flag, so the prompt doubles as the lyrics_prompt.
export const MUSIC_MODEL_DEFAULTS = {
    'ace-step-15': { duration_seconds: 210, format: 'flac' },
    'minimax-music-v2': { format: 'mp3', reusePromptAsLyrics: true },
    'minimax-music-v25': { format: 'mp3', extra: { force_instrumental: true } },
    'minimax-music-v26': { format: 'mp3', extra: { force_instrumental: true } },
    'stable-audio-25': { format: 'mp3' },
    'mmaudio-v2-text-to-audio': { format: 'mp3' },
    'elevenlabs-music': { format: 'mp3' },
    'elevenlabs-sound-effects-v2': { format: 'mp3' },
};
export const AUDIO_PROVIDER_DEFAULTS = {
    openai: { endpoint: '/audio/speech', voice: 'alloy', format: 'mp3' },
    groq: { endpoint: '/audio/speech', voice: 'tara', format: 'wav' },
    venice: { endpoint: '/audio/speech', voice: 'af_sky', format: 'mp3' },
};
export function getConfiguredModels() {
    const data = readJson(MODELS_FILE, {});
    return Object.entries(data).map(([id, meta]) => ({
        id,
        model: meta.model ?? (id.includes('/') ? id.split('/').slice(1).join('/') : id),
        alias: meta.alias ?? id,
        provider: meta.provider ?? (id.includes('/') ? id.split('/')[0] : 'unknown'),
        type: meta.type ?? inferModelType(id),
    }));
}
export function getModelsByProvider(provider) {
    return getConfiguredModels().filter((m) => m.provider === provider);
}
export function getModelEntry(modelId) {
    const data = readJson(MODELS_FILE, {});
    return data[modelId] ?? null;
}
export function addModelEntry(modelId, provider, model, alias) {
    const data = readJson(MODELS_FILE, {});
    data[modelId] = { provider, model, alias, base_url: '' };
    writeJson(MODELS_FILE, data);
}
export function saveModels(models, provider) {
    const data = readJson(MODELS_FILE, {});
    // Remove old entries for this provider
    for (const key of Object.keys(data)) {
        if (data[key]?.provider === provider)
            delete data[key];
    }
    for (const m of models) {
        const entry = { provider: m.provider, model: m.model, alias: m.alias, base_url: '' };
        if (m.context_window)
            entry['context_window'] = m.context_window;
        if (m.type)
            entry['type'] = m.type;
        data[m.id] = entry;
    }
    writeJson(MODELS_FILE, data);
}
// ─── Preferences ──────────────────────────────────────────────────────────
export function loadPreferences() {
    const prefs = readJson(PREFERENCES_FILE, {});
    if (!prefs.default_model_id) {
        const env = readEnvFile();
        const model = env['OPENAI_MODEL'] ?? '';
        const baseUrl = env['OPENAI_BASE_URL'] ?? '';
        let provider = '';
        if (baseUrl.includes('venice'))
            provider = 'venice';
        else if (baseUrl.includes('openrouter'))
            provider = 'openrouter';
        else if (baseUrl.includes('x.ai'))
            provider = 'xai';
        return {
            theme: 'dark',
            default_provider: provider,
            default_model: model,
            default_model_id: provider && model ? `${provider}/${model}` : model,
        };
    }
    return { theme: 'dark', ...prefs };
}
export function savePreferences(prefs) {
    const current = loadPreferences();
    writeJson(PREFERENCES_FILE, { ...current, ...prefs });
}
export function getCurrentPrimaryModel() {
    return loadPreferences().default_model_id ?? '';
}
// ─── Auth ─────────────────────────────────────────────────────────────────
export function getAuthToken() {
    const data = readJson(AUTH_FILE, {});
    return data.token ?? '';
}
// ─── Cost estimation ──────────────────────────────────────────────────────
// Per-model token cost in dollars per million. Order-sensitive: more
// specific patterns first (e.g. opus-4-6 before just 'claude'). Numbers
// are best-effort approximations for the most common SKUs at the time of
// writing — actual per-provider pricing may differ. When no pattern
// matches, getModelCost returns null so the UI can show "—" instead of a
// misleading guess.
const COST_MAP = [
    // Anthropic
    ['claude-opus-4-7', 15.0, 75.0],
    ['claude-opus-4-6', 15.0, 75.0],
    ['claude-opus-4', 15.0, 75.0],
    ['claude-sonnet-4-6', 3.0, 15.0],
    ['claude-sonnet-4', 3.0, 15.0],
    ['claude-haiku-4-5', 1.0, 5.0],
    ['claude-haiku-4', 1.0, 5.0],
    ['claude', 3.0, 15.0],
    // xAI
    ['grok-4', 5.0, 20.0],
    ['grok-3', 3.0, 15.0],
    ['grok', 3.0, 15.0],
    // Moonshot
    ['kimi-k2-6', 2.0, 8.0],
    ['kimi-k2', 2.0, 8.0],
    ['kimi', 2.0, 8.0],
    // Deepseek
    ['deepseek-v4', 0.5, 2.0],
    ['deepseek-v3', 0.27, 1.1],
    ['deepseek', 0.5, 2.0],
    // Meta
    ['llama-4-maverick', 0.2, 0.8],
    ['llama-4', 0.2, 0.8],
    ['llama-3', 0.15, 0.6],
    // Google
    ['gemini-2', 0.15, 0.6],
    ['gemini', 0.15, 0.6],
    ['gemma', 0.05, 0.15],
    // Mistral
    ['mistral-large', 2.0, 6.0],
    ['mistral', 0.4, 1.5],
    // OpenAI
    ['gpt-5', 5.0, 15.0],
    ['gpt-4o', 2.5, 10.0],
    ['gpt-4', 5.0, 15.0],
    ['o4', 3.0, 12.0],
    ['o3', 3.0, 12.0],
    // Qwen
    ['qwen3', 0.4, 1.5],
    ['qwen', 0.4, 1.5],
];
export function getModelCost(modelId) {
    const lower = modelId.toLowerCase();
    for (const [key, inp, out] of COST_MAP) {
        if (lower.includes(key))
            return { input_per_m: inp, output_per_m: out };
    }
    return null;
}
