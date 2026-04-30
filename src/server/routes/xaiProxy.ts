/**
 * xAI (Grok) proxy.
 *
 * Handles:
 * 1. Model-validation GET stub
 * 2. Claude/OpenClaude identity stripping
 * 3. /v1 double-prefix removal
 * 4. Image generation routing — grok-2-image / grok-imagine etc.
 *    Routes /chat/completions → /images/generations, returns markdown image.
 * 5. Video generation routing — grok-imagine-video etc.
 *    Routes /chat/completions → /videos/generations, polls if async.
 */
import { Hono } from 'hono'

const XAI_BASE = 'https://api.x.ai/v1'

const VIDEO_RE = /video/i
const IMAGE_RE = /\bimage\b|imagine/i  // checked after VIDEO_RE so "imagine-video" hits video first

// ── Media generation helpers ───────────────────────────────────────────────

function extractPrompt(messages: Array<Record<string, unknown>>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg['role'] === 'user') {
      const content = msg['content']
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        text = (content as Array<Record<string, unknown>>)
          .filter(b => b['type'] === 'text')
          .map(b => b['text'] as string)
          .join('\n')
          .trim()
      }
      if (!text) continue

      // openclaude wraps every user message with <system-reminder> and
      // <claude_mem_context> blocks (~6KB of injected context). The actual
      // user prompt is always appended after the last closing tag.
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

// Cache prevents duplicate generation for openclaude's stream:true + stream:false dual-request
const mediaCache = new Map<string, { content: string; ts: number }>()
const MEDIA_CACHE_TTL = 90_000

function mediaCacheKey(model: string, messages: unknown): string {
  return `${model}::${JSON.stringify(messages ?? []).slice(-300)}`
}

function pruneMediaCache() {
  const now = Date.now()
  for (const [k, v] of mediaCache) {
    if (now - v.ts > MEDIA_CACHE_TTL) mediaCache.delete(k)
  }
}

async function generateImage(authHeader: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(`${XAI_BASE}/images/generations`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, n: 1 }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`xAI image API ${res.status}: ${err}`)
  }
  const data = await res.json() as { data?: Array<{ url?: string }> }
  const url = data.data?.[0]?.url
  if (!url) throw new Error('xAI image API returned no URL')
  return url
}

async function generateVideo(authHeader: string, model: string, prompt: string): Promise<string> {
  // POST to start generation — returns {request_id} immediately
  const res = await fetch(`${XAI_BASE}/videos/generations`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`xAI video API ${res.status}: ${err}`)
  }
  const init = await res.json() as Record<string, unknown>
  const requestId = init['request_id'] as string | undefined
  if (!requestId) throw new Error('xAI video API returned no request_id')

  // Poll GET /v1/videos/{request_id} until status === "done"
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const poll = await fetch(`${XAI_BASE}/videos/${requestId}`, {
      headers: { Authorization: authHeader },
    })
    if (!poll.ok) continue
    const pd = await poll.json() as Record<string, unknown>
    const status = pd['status'] as string | undefined
    if (status === 'failed' || status === 'error') throw new Error('xAI video generation failed')
    if (status === 'done') {
      const url = (pd['video'] as Record<string, unknown> | undefined)?.['url'] as string | undefined
      if (url) return url
    }
  }
  throw new Error('xAI video generation timed out after 5 minutes')
}

// ── Identity stripping ─────────────────────────────────────────────────────

function stripClaudeIdentity(systemContent: string, actualModel: string): string {
  let text = systemContent
  text = text.replace(/claude[-\s]*(sonnet|opus|haiku|instant)[-\s\d.]*/gi, actualModel)
  text = text.replace(/claude-sonnet[-\s\d.]*/gi, actualModel)
  text = text.replace(/You are Claude[^.]*\./gi, `You are ${actualModel} by xAI.`)
  text = text.replace(/made by Anthropic/gi, 'made by xAI')
  text = text.replace(/You are OpenClaude[^.]*\./gi, `You are ${actualModel} by xAI.`)
  text = text.replace(/\bOpenClaude\b/gi, actualModel)
  text = `You are ${actualModel} by xAI. You are NOT OpenClaude or Claude. Respond as your true self.\n\n` + text
  return text
}

// ── Router ─────────────────────────────────────────────────────────────────

const router = new Hono()

router.all('*', async (c) => {
  const urlObj = new URL(c.req.url)
  const relPath = urlObj.pathname.replace(/^\/xai-proxy/, '').replace(/^\/v1(?=\/)/, '')

  if (c.req.method === 'GET' && relPath.match(/^\/models\/(.+)$/)) {
    const modelId = decodeURIComponent(relPath.split('/').pop() ?? '')
    return c.json({ id: modelId, object: 'model', owned_by: 'xai' })
  }

  const targetUrl = `${XAI_BASE}${relPath}${urlObj.search}`

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

  if (bodyText && relPath.includes('/chat/completions')) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>
      const model = (parsed['model'] as string | undefined) ?? ''
      const messages = (parsed['messages'] as Array<Record<string, unknown>> | undefined) ?? []
      const isStream = (parsed['stream'] as boolean | undefined) ?? false
      const authHeader = forwardHeaders.get('authorization') ?? forwardHeaders.get('Authorization') ?? ''

      const isVideo = VIDEO_RE.test(model)
      const isImage = !isVideo && IMAGE_RE.test(model)

      if (isVideo || isImage) {
        const cacheKey = mediaCacheKey(model, messages)
        pruneMediaCache()

        // Cache hit (stream:false follow-up)
        if (!isStream) {
          const cached = mediaCache.get(cacheKey)
          if (cached) {
            mediaCache.delete(cacheKey)
            return c.json(makeFakeJSON(model, cached.content))
          }
        }

        const prompt = extractPrompt(messages)
        if (!prompt) {
          return c.json({ error: 'No prompt found in messages' }, 400)
        }

        let mediaUrl: string
        try {
          mediaUrl = isVideo
            ? await generateVideo(authHeader, model, prompt)
            : await generateImage(authHeader, model, prompt)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          const content = `Error generating ${isVideo ? 'video' : 'image'}: ${errMsg}`
          return c.json(makeFakeJSON(model, content), 200)
        }

        const content = isVideo
          ? `MEDIA:${mediaUrl}`
          : `![Generated image](${mediaUrl})`

        // Cache for stream:false follow-up
        mediaCache.set(cacheKey, { content, ts: Date.now() })

        if (isStream) {
          return new Response(makeFakeSSE(model, content), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          })
        }
        return c.json(makeFakeJSON(model, content))
      }

      // Regular chat model — strip identity and forward
      const actualModel = model || 'grok'
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
    } catch { /* not JSON — forward as-is */ }
  }

  const upstreamRes = await fetch(targetUrl, {
    method: c.req.method,
    headers: forwardHeaders,
    body: bodyText,
  })

  const responseHeaders = new Headers(upstreamRes.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: responseHeaders,
  })
})

export default router
