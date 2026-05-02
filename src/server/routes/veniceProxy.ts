/**
 * Local proxy for Venice.ai that fixes known openclaude ↔ Venice bugs:
 *
 * Bug 1 — Reasoning-model empty content:
 *   Reasoning models (minimax-m27, etc.) return delta.content="" with the actual
 *   text in delta.reasoning_content / delta.reasoning_details. openclaude's
 *   OpenAI compatibility layer only reads delta.content → gets nothing → silent
 *   empty response.
 *   Fix: in streaming responses, copy reasoning_content → content in each SSE chunk.
 *
 * Bug 2 — Local-provider /v1 double-prefix:
 *   Same as OpenRouter proxy: openclaude prepends /v1 for localhost base URLs.
 *   Fix: strip leading /v1 from relPath before building the target URL.
 *
 * Bug 3 — Claude identity injection (openclaude ≤0.6.x) / OpenClaude identity (≥0.7.0):
 *   openclaude injects a system message claiming the model is "claude-sonnet-4-6"
 *   made by Anthropic (≤0.6.x) or "OpenClaude, an open-source coding agent and CLI"
 *   (≥0.7.0), even with --bare. Models echo this identity back verbatim.
 *   Fix: rewrite the injected system message to replace the false identity
 *   with the actual Venice model being called.
 *
 * Usage: set OPENAI_BASE_URL=http://localhost:8789/venice-proxy when switching to
 * a Venice model.
 */
import { Hono } from 'hono'
import { getModelEntry, inferModelType } from '../services/config.js'
import { saveBase64Media, saveBytesMedia } from '../services/media.js'

const VENICE_BASE = 'https://api.venice.ai/api/v1'

const router = new Hono()

// ── Image generation helpers (same dual-request cache pattern as xaiProxy) ──
const mediaCache = new Map<string, { content: string; ts: number }>()
const MEDIA_CACHE_TTL = 90_000

function pruneMediaCache() {
  const now = Date.now()
  for (const [k, v] of mediaCache) if (now - v.ts > MEDIA_CACHE_TTL) mediaCache.delete(k)
}

function extractPrompt(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg['role'] !== 'user') continue
    const content = msg['content']
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = (content as Array<Record<string, unknown>>)
        .filter((b) => b['type'] === 'text')
        .map((b) => b['text'] as string).join('\n').trim()
    }
    if (!text) continue
    if (text.includes('</')) {
      const lastClose = text.lastIndexOf('</')
      const tagEnd = text.indexOf('>', lastClose)
      if (tagEnd !== -1 && tagEnd < text.length - 1) {
        const clean = text.slice(tagEnd + 1).trim()
        if (clean) return clean.slice(0, 4000)
      }
    }
    return text.slice(0, 4000)
  }
  return ''
}

function makeFakeSSE(model: string, content: string): string {
  const id = `chatcmpl-media-${Date.now()}`
  const c = (delta: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
  return (
    c({ role: 'assistant', content: '' }) +
    c({ content }) +
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
    'data: [DONE]\n\n'
  )
}

function makeFakeJSON(model: string, content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-media-${Date.now()}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

async function generateVeniceVideo(authHeader: string, model: string, prompt: string): Promise<string> {
  // 1. Queue the job
  const queueRes = await fetch(`${VENICE_BASE}/video/queue`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, duration: '4s', resolution: '480p', aspect_ratio: '16:9' }),
  })
  if (!queueRes.ok) {
    const err = await queueRes.text()
    throw new Error(`Venice video queue ${queueRes.status}: ${err.slice(0, 300)}`)
  }
  const queueData = await queueRes.json() as { queue_id?: string }
  const queueId = queueData.queue_id
  if (!queueId) throw new Error('Venice video queue returned no queue_id')

  // 2. Poll retrieve. While processing, response is JSON {status: "PROCESSING"}.
  //    When done, response is the raw mp4 binary (Content-Type: video/mp4).
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 10_000))
    const poll = await fetch(`${VENICE_BASE}/video/retrieve`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue_id: queueId, model }),
    })
    if (!poll.ok) continue
    const ct = poll.headers.get('content-type') ?? ''
    if (ct.startsWith('video/')) {
      const bytes = new Uint8Array(await poll.arrayBuffer())
      const ext = ct.includes('mp4') ? 'mp4' : ct.includes('webm') ? 'webm' : 'mp4'
      const { url } = saveBytesMedia(bytes, ext)
      return url
    }
    // Still processing or error JSON
    const txt = await poll.text()
    try {
      const j = JSON.parse(txt) as { status?: string; error?: string }
      if (j.status === 'FAILED' || j.status === 'ERROR') {
        throw new Error(`Venice video failed: ${j.error ?? j.status}`)
      }
    } catch { /* keep polling */ }
  }
  throw new Error('Venice video generation timed out after 15 minutes')
}

async function generateVeniceImage(authHeader: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(`${VENICE_BASE}/image/generate`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, height: 1024, width: 1024 }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Venice image API ${res.status}: ${err.slice(0, 300)}`)
  }
  const data = (await res.json()) as { images?: string[] }
  const b64 = data.images?.[0]
  if (!b64) throw new Error('Venice image API returned no image data')
  // Venice returns base64 (typically WebP). Save to disk and return a serve URL.
  const { url } = saveBase64Media(b64)
  return url
}

function stripClaudeIdentity(systemContent: string, actualModel: string): string {
  let text = systemContent
  // Match old Claude identity patterns (≤0.6.x)
  text = text.replace(/claude[-\s]*(sonnet|opus|haiku|instant)[-\s\d.]*/gi, actualModel)
  text = text.replace(/claude-sonnet[-\s\d.]*/gi, actualModel)
  text = text.replace(/You are Claude[^.]*\./gi, `You are ${actualModel} via Venice.ai.`)
  text = text.replace(/made by Anthropic/gi, 'served via Venice.ai')
  // Match new OpenClaude identity (≥0.7.0)
  text = text.replace(/You are OpenClaude[^.]*\./gi, `You are ${actualModel} via Venice.ai.`)
  text = text.replace(/\bOpenClaude\b/gi, actualModel)
  text = `You are ${actualModel} served via Venice.ai. You are NOT OpenClaude or Claude. Respond as your true self.\n\n` + text
  return text
}

router.all('*', async (c) => {
  const urlObj = new URL(c.req.url)
  const relPath = urlObj.pathname.replace(/^\/venice-proxy/, '').replace(/^\/v1(?=\/)/, '')
  const targetUrl = `${VENICE_BASE}${relPath}${urlObj.search}`

  const forwardHeaders = new Headers()
  for (const [k, v] of Object.entries(c.req.header())) {
    const lk = k.toLowerCase()
    if (lk === 'host' || lk === 'content-length') continue
    forwardHeaders.set(k, v)
  }

  let bodyText: string | undefined
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    bodyText = await c.req.text()
  }

  // ── Image generation routing: detect image model and route to /image/generate ──
  if (bodyText && relPath.includes('/chat/completions')) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>
      const model = (parsed['model'] as string | undefined) ?? ''
      const entry = model ? getModelEntry(`venice/${model}`) : null
      const type = entry?.type ?? (model ? inferModelType(`venice/${model}`) : 'text')
      if (type === 'image' || type === 'video') {
        const messages = (parsed['messages'] as Array<Record<string, unknown>> | undefined) ?? []
        const isStream = (parsed['stream'] as boolean | undefined) ?? false
        const authHeader = forwardHeaders.get('authorization') ?? forwardHeaders.get('Authorization') ?? ''
        const cacheKey = `${model}::${JSON.stringify(messages).slice(-300)}`
        pruneMediaCache()

        // Cache hit (stream:false follow-up after stream:true)
        if (!isStream) {
          const cached = mediaCache.get(cacheKey)
          if (cached) {
            mediaCache.delete(cacheKey)
            return c.json(makeFakeJSON(model, cached.content))
          }
        }

        const prompt = extractPrompt(messages)
        if (!prompt) return c.json({ error: 'No prompt found in messages' }, 400)

        let mediaUrl: string
        try {
          mediaUrl = type === 'video'
            ? await generateVeniceVideo(authHeader, model, prompt)
            : await generateVeniceImage(authHeader, model, prompt)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return c.json(makeFakeJSON(model, `Error generating ${type}: ${msg}`), 200)
        }

        const content = `MEDIA:${mediaUrl}`
        mediaCache.set(cacheKey, { content, ts: Date.now() })

        if (isStream) {
          return new Response(makeFakeSSE(model, content), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          })
        }
        return c.json(makeFakeJSON(model, content))
      }
    } catch { /* not JSON or no entry — fall through to normal text routing */ }
  }

  // ── Bug 3: Strip Claude identity from system messages ────────────────────
  if (bodyText && relPath.includes('/chat/completions')) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>
      const actualModel = (parsed['model'] as string | undefined) ?? 'venice-model'
      const messages = parsed['messages'] as Array<Record<string, unknown>> | undefined
      if (Array.isArray(messages)) {
        let modified = false
        for (const msg of messages) {
          if (msg['role'] === 'system' && typeof msg['content'] === 'string') {
            msg['content'] = stripClaudeIdentity(msg['content'], actualModel)
            modified = true
          }
        }
        if (modified) {
          bodyText = JSON.stringify({ ...parsed, messages })
        }
      }
    } catch { /* not JSON — forward as-is */ }
  }

  const doFetch = (body: string | undefined) =>
    fetch(targetUrl, { method: c.req.method, headers: forwardHeaders, body })

  let upstreamRes = await doFetch(bodyText)

  // ── Bug 2: thinking-mode 400 retry ────────────────────────────────────────
  // Venice DeepSeek thinking models require reasoning_content to be passed back
  // in every follow-up turn. openclaude doesn't do this (standard OpenAI format).
  // Fix: on 400 with "reasoning_content" in the error, disable thinking mode and retry.
  if (!upstreamRes.ok && upstreamRes.status === 400 && bodyText) {
    const errText = await upstreamRes.text()
    if (errText.includes('reasoning_content') && bodyText) {
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>
        const vp = (parsed['venice_parameters'] ?? {}) as Record<string, unknown>
        const retryBody = { ...parsed, venice_parameters: { ...vp, disable_thinking: true } }
        upstreamRes = await doFetch(JSON.stringify(retryBody))
      } catch { /* not JSON — fall through */ }
    }
    if (!upstreamRes.ok) {
      const errBody = upstreamRes.bodyUsed ? '' : await upstreamRes.text()
      const responseHeaders = new Headers(upstreamRes.headers)
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      return new Response(errBody, { status: upstreamRes.status, headers: responseHeaders })
    }
  }

  const responseHeaders = new Headers(upstreamRes.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')

  // Non-streaming or non-chat: pass through as-is
  const contentType = upstreamRes.headers.get('content-type') ?? ''
  const isStream = contentType.includes('text/event-stream')

  if (!isStream || !upstreamRes.body) {
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    })
  }

  // ── Bug 1: Rewrite SSE stream — copy reasoning_content → content ──────────
  const upstream = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const rewritten = new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await upstream.read()
        if (done) { controller.close(); return }

        const text = decoder.decode(value, { stream: true })
        const lines = text.split('\n')
        const out: string[] = []

        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') {
            out.push(line)
            continue
          }
          try {
            const chunk = JSON.parse(line.slice(6)) as {
              choices?: Array<{
                delta?: {
                  content?: string
                  reasoning_content?: string
                  reasoning_details?: Array<{ text?: string }>
                }
              }>
            }
            const delta = chunk.choices?.[0]?.delta
            if (delta && (delta.content === '' || delta.content == null)) {
              // Promote reasoning_content to content so openclaude sees it
              const reasoningText =
                delta.reasoning_content ??
                delta.reasoning_details?.map((d) => d.text ?? '').join('') ??
                ''
              if (reasoningText) {
                delta.content = reasoningText
                delete delta.reasoning_content
                delete delta.reasoning_details
              }
            }
            out.push('data: ' + JSON.stringify(chunk))
          } catch {
            out.push(line)
          }
        }

        controller.enqueue(encoder.encode(out.join('\n')))
      }
    },
    cancel() { upstream.cancel() },
  })

  return new Response(rewritten, { status: upstreamRes.status, headers: responseHeaders })
})

export default router
