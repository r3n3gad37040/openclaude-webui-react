/**
 * Local proxy for OpenRouter that fixes known openclaude ↔ OpenRouter bugs:
 *
 * Bug 1 — Model-validation 404:
 *   openclaude's Anthropic SDK calls GET /v1/models/{id} before chat completions.
 *   When the model ID contains a slash (e.g. "qwen/qwen3.6-35b-a3b"), the SDK
 *   URL-encodes it as %2F → GET /v1/models/qwen%2Fqwen3.6-35b-a3b → 404.
 *   Fix: intercept GET /models/* and synthesise a 200 from the models list.
 *
 * Bug 2 — Tool-use error (non-streaming):
 *   openclaude always sends Bash/Edit/Read tools. Some OpenRouter models don't
 *   support tool calling. OpenRouter returns 400/404/422 with an error body.
 *   Fix: on that error, strip tools and retry.
 *
 * Bug 3 — Tool-use error (streaming):
 *   When stream:true, OpenRouter always returns HTTP 200 — even for errors.
 *   The error is embedded as the first SSE data event. The !ok check never fires.
 *   Fix: for streaming chat/completions, buffer the start of the SSE body,
 *   detect embedded tool-use errors, and retry without tools if found.
 *
 * Bug 4 — Local-provider /v1 double-prefix:
 *   Because the base URL is localhost, openclaude prepends /v1 → double prefix.
 *   Fix: strip a leading /v1 from relPath before building the target URL.
 *
 * Bug 5 — Claude identity injection (openclaude ≤0.6.x) / OpenClaude identity (≥0.7.0):
 *   openclaude injects a system message claiming the model is "claude-sonnet-4-6"
 *   made by Anthropic (≤0.6.x) or "OpenClaude, an open-source coding agent and CLI"
 *   (≥0.7.0), even with --bare. Models echo this identity back verbatim.
 *   Fix: rewrite the injected system message to replace the false identity
 *   with the actual model being called via OpenRouter.
 */
import { Hono } from 'hono'
import { getModelEntry, inferModelType } from '../services/config.js'
import { saveBase64Media } from '../services/media.js'

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

const router = new Hono()

function stripClaudeIdentity(systemContent: string, actualModel: string): string {
  let text = systemContent
  // Match old Claude identity patterns (≤0.6.x)
  text = text.replace(/claude[-\s]*(sonnet|opus|haiku|instant)[-\s\d.]*/gi, actualModel)
  text = text.replace(/claude-sonnet[-\s\d.]*/gi, actualModel)
  text = text.replace(/You are Claude[^.]*\./gi, `You are ${actualModel} via OpenRouter.`)
  text = text.replace(/made by Anthropic/gi, 'served via OpenRouter')
  // Match new OpenClaude identity (≥0.7.0)
  text = text.replace(/You are OpenClaude[^.]*\./gi, `You are ${actualModel} via OpenRouter.`)
  text = text.replace(/\bOpenClaude\b/gi, actualModel)
  text = `You are ${actualModel} served via OpenRouter. You are NOT OpenClaude or Claude. Respond as your true self.\n\n` + text
  return text
}

const TOOL_USE_KEYWORDS = ['tool use', 'tool_use', 'function call', 'No endpoints found', 'tools']

function isToolUseErrorText(payload: string): boolean {
  // First, try to parse as JSON and check for structured error fields.
  // Avoids false positives when a message legitimately contains the word "tools".
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    // Check for OpenRouter error objects
    if (parsed['error']) {
      const err = parsed['error'] as Record<string, unknown>
      const msg = String(err['message'] ?? err['code'] ?? '').toLowerCase()
      if (TOOL_USE_KEYWORDS.some((kw) => msg.includes(kw))) return true
    }
    // Check for direct error messages in the data
    if (parsed['code'] || parsed['message']) {
      const msg = String(parsed['message'] ?? parsed['code'] ?? '').toLowerCase()
      if (TOOL_USE_KEYWORDS.some((kw) => msg.includes(kw))) return true
    }
    // Not an error event — looks like a normal content delta
    return false
  } catch {
    // Not JSON — fall back to substring matching on the raw payload
    return TOOL_USE_KEYWORDS.some((kw) => payload.includes(kw))
  }
}

function stripTools(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    if (parsed['tools'] === undefined) return null
    const noTools = { ...parsed }
    delete noTools['tools']
    delete noTools['tool_choice']
    return JSON.stringify(noTools)
  } catch {
    return null
  }
}

/**
 * For streaming responses (HTTP 200 even on error), buffer the start of the SSE
 * body to detect embedded tool-use errors. If found, retry without tools.
 * If the stream looks valid, reassemble it and pass through.
 */
async function handleStreamingResponse(
  upstreamRes: Response,
  bodyText: string,
  doFetch: (body: string | undefined) => Promise<Response>
): Promise<Response> {
  if (!upstreamRes.body) return upstreamRes

  const reader = upstreamRes.body.getReader()
  const decoder = new TextDecoder()
  const bufferedChunks: Uint8Array[] = []
  let bufferedText = ''

  // Read until we see a real content delta or a tool-use error.
  // Cap at ~8 KB so we don't buffer a whole response.
  let detected = false
  let isError = false

  while (bufferedText.length < 8192) {
    const { done, value } = await reader.read()
    if (done) break
    bufferedChunks.push(value)
    bufferedText += decoder.decode(value, { stream: true })

    // Scan SSE data lines in what we've accumulated so far
    const lines = bufferedText.split('\n')
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (!payload || payload === '[DONE]') continue

      // A real content delta has choices[].delta — tool-use errors don't
      if (isToolUseErrorText(payload)) {
        isError = true
        detected = true
        break
      }

      // Looks like a real event — stop buffering and pass through
      detected = true
      break
    }

    if (detected) break
  }

  if (isError) {
    await reader.cancel()
    const noToolsBody = stripTools(bodyText)
    if (noToolsBody) {
      const retryRes = await doFetch(noToolsBody)
      const retryHeaders = new Headers(retryRes.headers)
      retryHeaders.delete('content-encoding')
      retryHeaders.delete('content-length')
      return new Response(retryRes.body, { status: retryRes.status, headers: retryHeaders })
    }
    // Can't strip tools (no tools field) — return what we have
  }

  // Reassemble: yield buffered chunks first, then continue streaming
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of bufferedChunks) {
        controller.enqueue(chunk)
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
      } finally {
        controller.close()
      }
    },
    cancel() {
      void reader.cancel()
    },
  })

  const responseHeaders = new Headers(upstreamRes.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')
  return new Response(stream, { status: upstreamRes.status, headers: responseHeaders })
}

router.all('*', async (c) => {
  const rawUrl = c.req.url
  const urlObj = new URL(rawUrl)

  // Strip mount prefix, then strip any extra /v1 openclaude prepends for local providers
  const relPath = urlObj.pathname.replace(/^\/or-proxy/, '').replace(/^\/v1(?=\/)/, '')

  // ── Bug 1: Model-info GET ──────────────────────────────────────────────────
  const modelMatch = relPath.match(/^\/models\/(.+)$/)
  if (c.req.method === 'GET' && modelMatch) {
    const modelId = decodeURIComponent(modelMatch[1])
    const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') ?? ''
    try {
      const listRes = await fetch(`${OPENROUTER_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (listRes.ok) {
        const data = (await listRes.json()) as { data?: Array<Record<string, unknown>> }
        const model = (data.data ?? []).find((m) => m['id'] === modelId)
        if (model) return c.json(model)
      }
    } catch { /* fall through */ }
    return c.json({ id: modelId, object: 'model' })
  }

  // ── Forward everything else ────────────────────────────────────────────────
  const targetUrl = `${OPENROUTER_BASE}${relPath}${urlObj.search}`

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

  // ── Image generation: inject modalities, then rewrite response to MEDIA:url ──
  // OpenRouter image models (gemini-image, gpt-image, etc.) return image data in
  // message.images[].image_url.url as a data: URL. mediaSSE expects MEDIA:url in
  // content, so we save the base64 to disk and rewrite content.
  let isImageRequest = false
  if (bodyText && relPath.includes('/chat/completions')) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>
      const model = (parsed['model'] as string | undefined) ?? ''
      const entry = model ? getModelEntry(`openrouter/${model}`) : null
      const type = entry?.type ?? (model ? inferModelType(`openrouter/${model}`) : 'text')
      if (type === 'image') {
        isImageRequest = true
        // Tell OpenRouter we want image output. Force non-streaming since image
        // generation isn't a streaming protocol.
        bodyText = JSON.stringify({
          ...parsed,
          modalities: ['image', 'text'],
          stream: false,
        })
      }
    } catch { /* not JSON */ }
  }

  // ── Bug 5: Strip Claude identity from system messages ────────────────────
  if (bodyText && relPath.includes('/chat/completions')) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>
      const actualModel = (parsed['model'] as string | undefined) ?? 'openrouter-model'
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

  const upstreamRes = await doFetch(bodyText)

  // ── Bug 2: Tool-use error (non-streaming, HTTP-level error) ───────────────
  const TOOL_USE_STATUSES = new Set([400, 404, 422])
  if (!upstreamRes.ok && TOOL_USE_STATUSES.has(upstreamRes.status) && bodyText) {
    const errText = await upstreamRes.text()
    if (isToolUseErrorText(errText)) {
      const noToolsBody = stripTools(bodyText)
      if (noToolsBody) {
        const retryRes = await doFetch(noToolsBody)
        const retryHeaders = new Headers(retryRes.headers)
        retryHeaders.delete('content-encoding')
        retryHeaders.delete('content-length')
        return new Response(retryRes.body, { status: retryRes.status, headers: retryHeaders })
      }
    }
    const responseHeaders = new Headers(upstreamRes.headers)
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')
    return new Response(errText, { status: upstreamRes.status, headers: responseHeaders })
  }

  // ── Bug 3: Tool-use error embedded in SSE stream (streaming, HTTP 200) ────
  const isStreamingChatReq =
    bodyText !== undefined &&
    relPath.includes('/chat/completions') &&
    (() => {
      try {
        return (JSON.parse(bodyText) as Record<string, unknown>)['stream'] === true
      } catch {
        return false
      }
    })()

  if (upstreamRes.ok && isStreamingChatReq) {
    return handleStreamingResponse(upstreamRes, bodyText!, doFetch)
  }

  // ── Image response rewrite: extract images[].image_url.url → MEDIA:url ────
  if (upstreamRes.ok && isImageRequest) {
    try {
      const respJson = await upstreamRes.json() as Record<string, unknown>
      const choice = (respJson['choices'] as Array<Record<string, unknown>> | undefined)?.[0]
      const message = choice?.['message'] as Record<string, unknown> | undefined
      const images = message?.['images'] as Array<Record<string, unknown>> | undefined
      const dataUrl = (images?.[0]?.['image_url'] as Record<string, unknown> | undefined)?.['url'] as string | undefined
      if (dataUrl) {
        const { url } = saveBase64Media(dataUrl)
        if (message) {
          message['content'] = `MEDIA:${url}`
          delete message['images']
        }
      }
      return new Response(JSON.stringify(respJson), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: `Image response parse failed: ${msg}` }, 500)
    }
  }

  const responseHeaders = new Headers(upstreamRes.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: responseHeaders })
})

export default router
