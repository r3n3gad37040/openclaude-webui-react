import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getSession, addMessage, deleteLastAssistantMessage } from '../services/session.js'
import { startRunner, cancelRunner } from '../services/runner.js'
import { getModelCost, getModelEntry, inferModelType, getProviderApiKey, PROXY_MAP, PROVIDER_MAP, AUDIO_PROVIDER_DEFAULTS, isMusicModel, MUSIC_MODEL_DEFAULTS } from '../services/config.js'
import { saveBytesMedia } from '../services/media.js'
import type { ToolCall } from '../../types/index.js'

const CLAUDE_MEM_URL = 'http://127.0.0.1:37777'
// Both projects injected: openclaude-webui for project-specific work, johnny for general user context
const CLAUDE_MEM_PROJECTS = 'openclaude-webui,johnny'

// Returns the compact observation-index format that the terminal SessionStart hook injects.
// Plain text — NOT JSON. Do not JSON.parse() this.
async function fetchMemoryContext(): Promise<string> {
  try {
    const res = await fetch(
      `${CLAUDE_MEM_URL}/api/context/inject?projects=${CLAUDE_MEM_PROJECTS}`,
      { signal: AbortSignal.timeout(3000) }
    )
    if (!res.ok) return ''
    return await res.text()
  } catch {
    return ''
  }
}

// Register the webui session in claude-mem so summaries are tracked per-session.
// Fire-and-forget — failure is non-fatal.
async function initMemSession(contentSessionId: string, firstPrompt: string): Promise<void> {
  try {
    await fetch(`${CLAUDE_MEM_URL}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        project: 'openclaude-webui',
        prompt: firstPrompt,
        platformSource: 'claude',
      }),
      signal: AbortSignal.timeout(3000),
    })
  } catch { /* non-critical */ }
}

// Save an exchange summary back to claude-mem so future sessions can recall what was done.
// This is what makes webui work visible to the terminal and vice versa.
async function saveMemSummary(contentSessionId: string, request: string, completed: string): Promise<void> {
  try {
    await fetch(`${CLAUDE_MEM_URL}/api/sessions/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        request: request.slice(0, 2000),
        completed: completed.slice(0, 5000),
      }),
      signal: AbortSignal.timeout(5000),
    })
  } catch { /* non-critical */ }
}

// ─── Conversation history + context-window management ────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// contextWindow: per-model total context. Reserve 40% for output + system overhead.
// Default 128K covers most models; small OpenRouter free models should have context_window
// set via discovery.
function buildConversationPrompt(
  history: Array<{ role: string; content: string }>,
  content: string,
  memCtx: string,
  contextWindow = 128_000
): string {
  // 60% of total context for all input (history + memory + current)
  const inputBudget = Math.floor(contextWindow * 0.6)
  const historyBudget = inputBudget - estimateTokens(memCtx) - estimateTokens(content)

  // Walk backwards: keep newest turns that fit within the token budget
  const parts: string[] = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    const label = m.role === 'user' ? 'Human' : 'Assistant'
    const entry = `${label}: ${m.content}`
    const t = estimateTokens(entry)
    if (used + t > Math.max(0, historyBudget)) break
    parts.unshift(entry)
    used += t
  }

  let prompt = content
  if (parts.length > 0) {
    prompt = `<conversation_history>\n${parts.join('\n\n')}\n</conversation_history>\n\n${prompt}`
  }
  if (memCtx) {
    prompt = `<claude_mem_context>\n${memCtx}\n</claude_mem_context>\n\n${prompt}`
  }
  return prompt
}

// ── Direct media generation (image/video) — bypasses openclaude CLI ──────────
// openclaude doesn't emit stdout events for non-text model responses, so we
// call the proxy directly instead of spawning the CLI.

// Music-gen flow (Venice /audio/queue + /audio/retrieve, async). Submits a
// queue job, polls retrieve until binary audio comes back. Used for any model
// where isMusicModel() is true — these produce 30s-3min songs that can't go
// through the sync /audio/speech path.
async function generateMusicInline(
  stream: { writeSSE: (m: { data: string }) => Promise<void> },
  sessionId: string,
  provider: string,
  model: string,
  prompt: string,
  userContent: string,
): Promise<void> {
  const apiKey = getProviderApiKey(provider)
  const baseUrl = PROVIDER_MAP[provider]?.base_url
  if (!apiKey || !baseUrl) {
    const msg = `No API key or base URL configured for ${provider}`
    await stream.writeSSE({ data: JSON.stringify({ type: 'error', content: msg }) })
    await addMessage(sessionId, 'assistant', msg)
    return
  }
  if (provider !== 'venice') {
    const msg = `Music generation only wired for Venice currently; ${provider} not supported.`
    await stream.writeSSE({ data: JSON.stringify({ type: 'error', content: msg }) })
    await addMessage(sessionId, 'assistant', msg)
    return
  }

  const cfg = MUSIC_MODEL_DEFAULTS[model] ?? { format: 'mp3' as const }
  // Venice's /audio/queue requires prompt length >= 10 and rejects unknown keys.
  // Build the body conditionally per-model so we only send fields each variant
  // actually accepts.
  const queueBody: Record<string, unknown> = { model, prompt: prompt.slice(0, 500) }
  if (cfg.duration_seconds !== undefined) queueBody['duration_seconds'] = cfg.duration_seconds
  if (cfg.reusePromptAsLyrics) queueBody['lyrics_prompt'] = prompt.slice(0, 4000)
  if (cfg.extra) Object.assign(queueBody, cfg.extra)

  const queueRes = await fetch(`${baseUrl}/audio/queue`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(queueBody),
  })
  if (!queueRes.ok) {
    const errBody = await queueRes.text().catch(() => '')
    const msg = `Music queue failed (${queueRes.status}): ${errBody.slice(0, 300)}`
    process.stderr.write(`[mediaSSE:music] ${msg}\n`)
    await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: msg }) })
    await addMessage(sessionId, 'assistant', msg)
    return
  }
  const queueData = await queueRes.json() as { queue_id?: string }
  const queueId = queueData.queue_id
  if (!queueId) {
    const msg = 'Music queue returned no queue_id'
    await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: msg }) })
    await addMessage(sessionId, 'assistant', msg)
    return
  }

  // Poll /audio/retrieve. While processing, returns JSON {status:"PROCESSING"|"QUEUED"}.
  // When ready, returns binary audio with audio/* content-type.
  // ace-step at 210s typically completes in ~30-90s; cap at 10 min for safety.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 10_000))
    const poll = await fetch(`${baseUrl}/audio/retrieve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue_id: queueId, model }),
    })
    if (!poll.ok) continue
    const ct = poll.headers.get('content-type') ?? ''
    if (ct.startsWith('audio/')) {
      const buf = new Uint8Array(await poll.arrayBuffer())
      const ext: 'flac' | 'mp3' | 'wav' | 'ogg' =
        ct.includes('flac') ? 'flac' :
        ct.includes('wav') ? 'wav' :
        ct.includes('ogg') ? 'ogg' :
        cfg.format === 'flac' ? 'flac' : 'mp3'
      const { url } = saveBytesMedia(buf, ext)
      const alt = `Generated song (${model})`
      await stream.writeSSE({ data: JSON.stringify({ type: 'media', url, media_type: 'audio', alt }) })
      await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: '​' }) })
      await addMessage(sessionId, 'assistant', '​', {
        generated_media: [{ url, media_type: 'audio', alt }],
      })
      void saveMemSummary(sessionId, userContent, `Generated song: ${url}`)
      return
    }
    // Status JSON — check for terminal failure
    try {
      const txt = await poll.text()
      const j = JSON.parse(txt) as { status?: string; error?: string }
      if (j.status === 'FAILED' || j.status === 'ERROR') {
        const msg = `Music generation failed: ${j.error ?? j.status}`
        await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: msg }) })
        await addMessage(sessionId, 'assistant', msg)
        return
      }
    } catch { /* keep polling */ }
  }
  const msg = 'Music generation timed out after 10 minutes'
  await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: msg }) })
  await addMessage(sessionId, 'assistant', msg)
}

// Calls upstream /v1/audio/speech directly (no proxy hop — TTS is a one-shot
// POST returning binary, no identity stripping or chat-completions wrapping
// needed). Saves bytes via saveBytesMedia, emits media_type:"audio" so the UI
// can render <audio controls>.
async function generateAudioInline(
  stream: { writeSSE: (m: { data: string }) => Promise<void> },
  sessionId: string,
  provider: string,
  model: string,
  prompt: string,
  userContent: string,
): Promise<void> {
  // Music models go through the async queue/retrieve flow — completely
  // different API shape from sync TTS. Route early.
  if (isMusicModel(model)) {
    await generateMusicInline(stream, sessionId, provider, model, prompt, userContent)
    return
  }

  const apiKey = getProviderApiKey(provider)
  const baseUrl = PROVIDER_MAP[provider]?.base_url
  const cfg = AUDIO_PROVIDER_DEFAULTS[provider]

  if (!apiKey || !baseUrl) {
    const msg = `No API key or base URL configured for ${provider}`
    await stream.writeSSE({ data: JSON.stringify({ type: 'error', content: msg }) })
    await addMessage(sessionId, 'assistant', msg)
    return
  }
  if (!cfg) {
    const msg = `Audio generation not yet wired for provider "${provider}". Add a row to AUDIO_PROVIDER_DEFAULTS.`
    await stream.writeSSE({ data: JSON.stringify({ type: 'error', content: msg }) })
    await addMessage(sessionId, 'assistant', msg)
    return
  }

  // OpenAI TTS hard-caps input at 4096 chars; truncate defensively for all providers.
  const input = prompt.slice(0, 4000)

  const res = await fetch(`${cfg.base_url_override ?? baseUrl}${cfg.endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, voice: cfg.voice, response_format: cfg.format }),
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const msg = `Audio generation failed (${res.status}): ${errBody.slice(0, 300)}`
    process.stderr.write(`[mediaSSE:audio] ${msg}\n`)
    await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: msg }) })
    await addMessage(sessionId, 'assistant', msg)
    return
  }

  const buf = new Uint8Array(await res.arrayBuffer())
  const { url } = saveBytesMedia(buf, cfg.format)
  const alt = `Generated audio (${model})`

  await stream.writeSSE({ data: JSON.stringify({ type: 'media', url, media_type: 'audio', alt }) })
  await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: '​' }) })
  await addMessage(sessionId, 'assistant', '​', {
    generated_media: [{ url, media_type: 'audio', alt }],
  })
  void saveMemSummary(sessionId, userContent, `Generated audio: ${url}`)
}

function mediaSSE(c: Context, sessionId: string, modelId: string, prompt: string, userContent: string) {
  return streamSSE(c, async (stream) => {
    const slashIdx = modelId.indexOf('/')
    const provider = slashIdx !== -1 ? modelId.slice(0, slashIdx) : ''
    const model = slashIdx !== -1 ? modelId.slice(slashIdx + 1) : modelId
    const apiKey = provider ? getProviderApiKey(provider) : null
    const proxyBase = PROXY_MAP[provider] ?? ''
    const modelType = inferModelType(modelId)

    // Audio (TTS) and music both bypass proxyBase — they call upstream provider
    // endpoints directly. generate{Audio,Music}Inline validate apiKey/base_url
    // themselves. The proxyBase guard only applies to image/video.
    if (modelType !== 'audio' && modelType !== 'music' && (!apiKey || !proxyBase)) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', content: 'No API key or proxy configured for ' + provider }) })
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
      return
    }

    const keepalive = setInterval(() => { void stream.write(': keepalive\n\n') }, 15_000)
    stream.onAbort(() => clearInterval(keepalive))

    // Live tool indicator so the UI shows an animated "running" badge while
    // the proxy generates (image: ~10s, video: 30s-3min, audio: 2-15s).
    const toolName = modelType === 'video' ? '🎬 Generating video'
      : modelType === 'music' ? '🎵 Generating song'
      : modelType === 'audio' ? '🎙️ Generating audio'
      : '🎨 Generating image'
    const toolId = `media-gen-${Date.now()}`
    await stream.writeSSE({ data: JSON.stringify({ type: 'tool_start', name: toolName, tool_id: toolId }) })
    // Force the assistant message bubble to render immediately. The bundle's
    // tool indicator only shows once the bubble exists, and the bubble only
    // exists after the first chunk arrives. For long-running music gens (15-90s)
    // the user otherwise sees nothing until completion. Zero-width space is
    // invisible visually but counts as content.
    await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: '​' }) })

    try {
      if (modelType === 'music') {
        await generateMusicInline(stream, sessionId, provider, model, prompt, userContent)
        return
      }
      if (modelType === 'audio') {
        await generateAudioInline(stream, sessionId, provider, model, prompt, userContent)
        return
      }

      const res = await fetch(`${proxyBase}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
      })

      let content = ''
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>
        content = ((data['choices'] as Array<Record<string, unknown>> | undefined)?.[0]?.['message'] as Record<string, unknown> | undefined)?.['content'] as string ?? ''
      } else {
        const err = await res.text()
        content = `Error generating media: ${res.status} ${err.slice(0, 200)}`
      }

      // Extract media URL from proxy response. Proxy returns either
      // `MEDIA:url` (video) or `![Generated image](url)` (image).
      const mediaPrefix = content.match(/MEDIA:(\S+)/)
      const mdImage = content.match(/!\[.*?\]\((\S+?)\)/)
      const url = mediaPrefix?.[1] ?? mdImage?.[1] ?? ''

      if (url) {
        // Pull extension from the URL — including from a `?path=...` query when the
        // URL is /api/media/serve?path=/abs/path.ext (Venice/OpenRouter image case).
        const fromPath = decodeURIComponent(url).match(/\.([a-z0-9]{2,5})(?:\b|$)/gi)?.pop() ?? ''
        const ext = fromPath.replace('.', '').toLowerCase()
        const mediaType: 'image' | 'video' = ['mp4','webm','ogg','mov','avi','mkv'].includes(ext) ? 'video' : 'image'
        const alt = `Generated ${mediaType}`

        // Send media event so it renders inline via generated_media
        await stream.writeSSE({ data: JSON.stringify({ type: 'media', url, media_type: mediaType, alt }) })
        // Zero-width space chunk so onDone adds the message to local state
        await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: '​' }) })

        await addMessage(sessionId, 'assistant', '​', {
          generated_media: [{ url, media_type: mediaType, alt }],
        })
        void saveMemSummary(sessionId, userContent, `Generated ${mediaType}: ${url}`)
      } else {
        // No URL extracted — show whatever we got (or a default error) so the
        // user always sees a visible result instead of a silently-empty turn.
        const fallback = content.trim() || `Error: media generation returned no output (model=${model}, status=${res.status})`
        await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: fallback }) })
        await addMessage(sessionId, 'assistant', fallback)
      }
    } catch (err) {
      const msg = `Error generating media: ${err instanceof Error ? err.message : String(err)}`
      process.stderr.write(`[mediaSSE] ${msg}\n`)
      await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', content: msg }) })
      await addMessage(sessionId, 'assistant', msg)
    } finally {
      clearInterval(keepalive)
      await stream.writeSSE({ data: JSON.stringify({ type: 'tool_done', name: toolName, tool_id: toolId, input: prompt }) })
      await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
    }
  })
}

const router = new Hono()

function sseStream(
  c: Context,
  sessionId: string,
  modelId: string,
  prompt: string,
  runnerOptions: {
    systemPrompt?: string
    temperaturePreset?: string
    // Original user content (without memory prefix) for write-back to claude-mem
    userContent?: string
  } = {}
) {
  return streamSSE(c, async (stream) => {
    const runner = startRunner(sessionId, modelId, prompt, runnerOptions)
    let responseText = ''
    let usage: { input_tokens: number; output_tokens: number } | null = null
    const turnToolCalls: ToolCall[] = []
    const turnMedia: Array<{ url: string; media_type: 'image' | 'video'; alt?: string; width?: number; height?: number }> = []

    // Keepalive: send SSE comment every 15s so the Vite proxy / any intermediary
    // doesn't close the connection during slow models (high TTFT).
    const keepalive = setInterval(() => {
      void stream.write(': keepalive\n\n')
    }, 15_000)

    stream.onAbort(() => {
      clearInterval(keepalive)
      cancelRunner(sessionId)
    })

    const buildExtra = (): Record<string, unknown> => {
      const extra: Record<string, unknown> = {}
      if (usage) {
        const costs = getModelCost(modelId)
        extra['input_tokens'] = usage.input_tokens
        extra['output_tokens'] = usage.output_tokens
        extra['estimated_cost'] = parseFloat(
          (
            (usage.input_tokens * costs.input_per_m) / 1_000_000 +
            (usage.output_tokens * costs.output_per_m) / 1_000_000
          ).toFixed(6)
        )
      }
      if (turnToolCalls.length > 0) {
        extra['tool_calls'] = [...turnToolCalls]
      }
      if (turnMedia.length > 0) {
        extra['generated_media'] = [...turnMedia]
      }
      return extra
    }

    try {
      for await (const event of runner.events) {
        if (event.type === 'chunk') {
          responseText += event.content
          await stream.writeSSE({
            data: JSON.stringify({ type: 'chunk', content: event.content }),
          })
        } else if (event.type === 'tool_start') {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'tool_start', name: event.name, tool_id: event.tool_id }),
          })
        } else if (event.type === 'tool_done') {
          turnToolCalls.push({ tool_id: event.tool_id, name: event.name, input: event.input })
          await stream.writeSSE({
            data: JSON.stringify({ type: 'tool_done', name: event.name, tool_id: event.tool_id, input: event.input }),
          })
        } else if (event.type === 'error') {
          await stream.writeSSE({
            data: JSON.stringify({ type: 'error', content: event.content }),
          })
        } else if (event.type === 'media') {
          turnMedia.push({ url: event.url, media_type: event.media_type, alt: event.alt, width: event.width, height: event.height })
          await stream.writeSSE({
            data: JSON.stringify({ type: 'media', url: event.url, media_type: event.media_type, alt: event.alt, width: event.width, height: event.height }),
          })
        } else if (event.type === 'usage') {
          usage = event.data
          await stream.writeSSE({
            data: JSON.stringify({ type: 'usage', data: event.data }),
          })
        } else if (event.type === 'done') {
          // Save message BEFORE sending done — client refetches immediately on done
          // and addMessage must be on disk before the GET /sessions/:id arrives.
          if (responseText.trim()) {
            await addMessage(sessionId, 'assistant', responseText.trim(), buildExtra())
            // Write exchange summary back to claude-mem for cross-session recall
            if (runnerOptions.userContent) {
              void saveMemSummary(sessionId, runnerOptions.userContent, responseText.trim())
            }
            responseText = ''
          }
          await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) })
          break
        }
      }
    } finally {
      clearInterval(keepalive)
      if (responseText.trim()) {
        await addMessage(sessionId, 'assistant', responseText.trim(), buildExtra())
        if (runnerOptions.userContent) {
          void saveMemSummary(sessionId, runnerOptions.userContent, responseText.trim())
        }
      }
      cancelRunner(sessionId)
    }
  })
}

router.post('/:id/messages', async (c) => {
  const sessionId = c.req.param('id')
  const session = getSession(sessionId)
  if (!session) return c.json({ error: 'Session not found' }, 404)

  const body = await c.req.json<{
    message?: string
    content?: string
    attachments?: Array<{ name: string; path: string; size: number }>
  }>().catch(() => ({}))

  const content = (body.message ?? body.content ?? '').trim()
  if (!content && !body.attachments?.length) return c.json({ error: 'Empty message' }, 400)

  const isFirstMessage = session.messages.length === 0

  // Memory context only on the first message — subsequent turns have history in the prompt.
  // Saves a 3s blocking fetch on every subsequent turn.
  const memCtx = isFirstMessage ? await fetchMemoryContext() : ''

  // Per-model context window: read from models.json (populated by discovery) or fall back to 128K.
  const modelEntry = getModelEntry(session.model_id)
  const contextWindow = modelEntry?.context_window ?? 128_000

  // Build prompt: history transcript + memory context + current message.
  // session.messages at this point contains all prior turns (current user msg not yet added).
  let prompt = buildConversationPrompt(session.messages, content, memCtx, contextWindow)

  // Register new sessions with claude-mem so write-back summaries are tracked correctly
  if (isFirstMessage) {
    void initMemSession(sessionId, content)
  }

  // Append attachment file paths so openclaude can read them
  if (body.attachments?.length) {
    const fileList = body.attachments.map((a) => a.path).join('\n')
    prompt = `${prompt}\n\nAttached files:\n${fileList}`
  }

  void addMessage(sessionId, 'user', content)  // fire-and-forget — sseStream returns immediately

  // Media models (image/video) bypass openclaude — the CLI never emits stdout events for them.
  const modelType = inferModelType(session.model_id)
  if (modelType === 'image' || modelType === 'video' || modelType === 'audio' || modelType === 'music') {
    return mediaSSE(c, sessionId, session.model_id, content, content)
  }

  return sseStream(c, sessionId, session.model_id, prompt, {
    systemPrompt: session.system_prompt,
    temperaturePreset: session.temperature_preset,
    userContent: content,
  })
})

router.post('/:id/cancel', (c) => {
  cancelRunner(c.req.param('id'))
  return c.json({ status: 'ok' })
})

router.post('/regenerate', async (c) => {
  const body = await c.req.json<{ session_id?: string }>().catch(() => ({}))
  const sessionId = body.session_id ?? ''
  if (!sessionId) return c.json({ error: 'session_id is required' }, 400)

  const session = getSession(sessionId)
  if (!session) return c.json({ error: 'Session not found' }, 404)

  const { deleted, lastUserMessage } = await deleteLastAssistantMessage(sessionId)
  if (!deleted || !lastUserMessage) {
    return c.json({ error: 'Nothing to regenerate' }, 400)
  }

  // Refetch session after deletion to get clean message list for history.
  // Exclude the last user message from history since it's the current prompt.
  const updatedSession = getSession(sessionId)!
  const historyWithoutCurrent = updatedSession.messages.slice(0, -1)

  // No memory injection on regenerate — session already has established context.
  const modelEntry = getModelEntry(session.model_id)
  const contextWindow = modelEntry?.context_window ?? 128_000
  const prompt = buildConversationPrompt(historyWithoutCurrent, lastUserMessage, '', contextWindow)

  cancelRunner(sessionId)
  return sseStream(c, sessionId, session.model_id, prompt, {
    userContent: lastUserMessage,
  })
})

export default router
