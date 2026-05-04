/**
 * Generic proxy factory for providers that need Claude-identity stripping.
 * All providers: strip /v1 double-prefix, stub model-info GET, rewrite system message identity.
 */
import { Hono } from 'hono'

function stripClaudeIdentity(systemContent: string, actualModel: string, providerName: string): string {
  let text = systemContent
  // Match old Claude identity patterns (≤0.6.x)
  text = text.replace(/claude[-\s]*(sonnet|opus|haiku|instant)[-\s\d.]*/gi, actualModel)
  text = text.replace(/claude-sonnet[-\s\d.]*/gi, actualModel)
  text = text.replace(/You are Claude[^.]*\./gi, `You are ${actualModel} by ${providerName}.`)
  text = text.replace(/made by Anthropic/gi, `made by ${providerName}`)
  // Match new OpenClaude identity (≥0.7.0)
  text = text.replace(/You are OpenClaude[^.]*\./gi, `You are ${actualModel} by ${providerName}.`)
  text = text.replace(/\bOpenClaude\b/gi, actualModel)
  text = `You are ${actualModel} by ${providerName}. You are NOT OpenClaude or Claude. Respond as your true self.\n\n` + text
  return text
}

// Transform a Groq Compound SSE stream:
// - Renames delta.reasoning → delta.content (Compound uses non-standard field)
// - Strips <think>...</think> wrapper from reasoning to expose only the final answer
function createGroqCompoundTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  let inThinkBlock = false
  let thoughtBuf = ''

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      let output = ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          output += line + '\n'
          continue
        }
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') {
          output += 'data: [DONE]\n'
          continue
        }
        try {
          const event = JSON.parse(payload) as Record<string, unknown>
          const choices = event['choices'] as Array<Record<string, unknown>> | undefined
          if (Array.isArray(choices) && choices[0]) {
            const delta = choices[0]['delta'] as Record<string, unknown> | undefined
            if (delta && typeof delta['reasoning'] === 'string') {
              let text = delta['reasoning'] as string
              // Process <think>...</think> wrapper:
              // Accumulate thinking text, emit actual content after </think>
              let emitText = ''
              while (text.length > 0) {
                if (!inThinkBlock) {
                  const thinkStart = text.indexOf('<think>')
                  if (thinkStart === -1) {
                    // No think block — emit as content
                    emitText += text
                    text = ''
                  } else {
                    // Emit text before <think>, enter think block
                    emitText += text.slice(0, thinkStart)
                    text = text.slice(thinkStart + 7)
                    inThinkBlock = true
                    thoughtBuf = ''
                  }
                } else {
                  const thinkEnd = text.indexOf('</think>')
                  if (thinkEnd === -1) {
                    // Still inside think block — accumulate
                    thoughtBuf += text
                    text = ''
                  } else {
                    // End of think block — discard accumulated thought, continue
                    text = text.slice(thinkEnd + 8)
                    inThinkBlock = false
                    thoughtBuf = ''
                  }
                }
              }
              if (emitText) {
                delta['content'] = emitText
              } else {
                // Thinking in progress — suppress this chunk entirely
                delete choices[0]
                output += '' // skip
                continue
              }
              delete delta['reasoning']
              choices[0]['delta'] = delta
              event['choices'] = choices.filter(Boolean)
            }
          }
          output += `data: ${JSON.stringify(event)}\n`
        } catch {
          output += line + '\n'
        }
      }
      if (output) controller.enqueue(encoder.encode(output))
    },
    flush(controller) {
      if (buf) controller.enqueue(encoder.encode(buf))
    },
  })
}

// Convert SSE streaming response to a non-streaming ChatCompletion JSON object.
async function sseToJson(
  sseStream: ReadableStream<Uint8Array>,
  model: string
): Promise<Record<string, unknown>> {
  const reader = sseStream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let id = `chatcmpl-${Date.now()}`
  let finishReason: string | null = 'stop'
  const contentParts: string[] = []
  let usage: Record<string, unknown> | null = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') break
        try {
          const chunk = JSON.parse(payload) as Record<string, unknown>
          if (chunk['id']) id = chunk['id'] as string
          const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined
          if (Array.isArray(choices) && choices[0]) {
            const delta = choices[0]['delta'] as Record<string, unknown> | undefined
            // Capture both content and reasoning (Groq Compound uses reasoning)
            const text = (delta?.['content'] ?? delta?.['reasoning']) as string | undefined
            if (text) contentParts.push(text)
            if (choices[0]['finish_reason']) finishReason = choices[0]['finish_reason'] as string
          }
          const xgroq = chunk['x_groq'] as Record<string, unknown> | undefined
          if (xgroq?.['usage']) usage = xgroq['usage'] as Record<string, unknown>
          if (chunk['usage']) usage = chunk['usage'] as Record<string, unknown>
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const result: Record<string, unknown> = {
    id,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: contentParts.join('') }, finish_reason: finishReason }],
  }
  if (usage) result['usage'] = usage
  return result
}

// Cache: keyed by (model + serialized messages tail), stores the converted JSON response.
// openclaude sends stream:true first, then stream:false for the same request.
const streamCache = new Map<string, { json: Record<string, unknown>; ts: number }>()
const CACHE_TTL_MS = 60_000

function cacheKey(model: string, messages: unknown): string {
  const serialized = JSON.stringify(messages ?? [])
  return `${model}::${serialized.slice(-500)}`
}

function pruneCache() {
  const now = Date.now()
  for (const [k, v] of streamCache) {
    if (now - v.ts > CACHE_TTL_MS) streamCache.delete(k)
  }
}

export interface ProxyOptions {
  pathPrefix: string            // e.g. "groq-proxy"
  baseUrl: string               // e.g. "https://api.groq.com/openai/v1"
  providerName: string          // e.g. "Groq"
  defaultModel: string          // fallback when parsed model is empty
  ownedBy: string               // returned in model-info stub
  maxOutputTokens?: number      // clamp max_tokens to this value if provider has a hard cap
  noToolsPatterns?: RegExp[]    // strip tools/tool_choice for models matching these patterns
  requiresStreamingPatterns?: RegExp[]  // models requiring stream:true + response transformation
}

export function createGenericProxy(opts: ProxyOptions): Hono {
  const router = new Hono()
  const prefixRe = new RegExp(`^\\/${opts.pathPrefix}`)

  router.all('*', async (c) => {
    const urlObj = new URL(c.req.url)
    const relPath = urlObj.pathname.replace(prefixRe, '').replace(/^\/v1(?=\/)/, '')

    // Stub model-info GET so openclaude's validation passes
    const modelMatch = relPath.match(/^\/models\/(.+)$/)
    if (c.req.method === 'GET' && modelMatch) {
      const modelId = decodeURIComponent(modelMatch[1])
      return c.json({ id: modelId, object: 'model', owned_by: opts.ownedBy })
    }

    const targetUrl = `${opts.baseUrl}${relPath}${urlObj.search}`

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

    let streamCacheKey: string | null = null
    let isRequiresStreamingModel = false
    let isNonStreamingRequest = false
    let actualModel = opts.defaultModel

    if (bodyText && relPath.includes('/chat/completions')) {
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>
        actualModel = (parsed['model'] as string | undefined) ?? opts.defaultModel
        const messages = parsed['messages'] as Array<Record<string, unknown>> | undefined
        let patchedBody = { ...parsed }

        // Clamp max_tokens if provider has a hard cap
        if (opts.maxOutputTokens !== undefined) {
          const requested = parsed['max_tokens'] as number | undefined
          if (requested === undefined || requested > opts.maxOutputTokens) {
            patchedBody['max_tokens'] = opts.maxOutputTokens
          }
        }

        // Strip tool calling for models that don't support it
        if (opts.noToolsPatterns?.some(re => re.test(actualModel))) {
          delete patchedBody['tools']
          delete patchedBody['tool_choice']
        }

        // Handle models that require streaming
        if (opts.requiresStreamingPatterns?.some(re => re.test(actualModel))) {
          isRequiresStreamingModel = true
          streamCacheKey = cacheKey(actualModel, messages)
          pruneCache()

          if (parsed['stream'] === false) {
            isNonStreamingRequest = true
            // Serve from cache if the streaming response already completed
            const cached = streamCache.get(streamCacheKey)
            if (cached) {
              streamCache.delete(streamCacheKey)
              return c.json(cached.json)
            }
            // Cache miss: force stream:true and convert inline
            patchedBody['stream'] = true
          }
        }

        if (Array.isArray(messages)) {
          let modified = false
          for (const msg of messages) {
            if (msg['role'] === 'system' && typeof msg['content'] === 'string') {
              msg['content'] = stripClaudeIdentity(msg['content'], actualModel, opts.providerName)
              modified = true
            }
          }
          if (modified) patchedBody = { ...patchedBody, messages }
        }

        bodyText = JSON.stringify(patchedBody)
      } catch { /* not JSON — forward as-is */ }
    }

    const upstreamRes = await fetch(targetUrl, {
      method: c.req.method,
      headers: forwardHeaders,
      body: bodyText,
      signal: AbortSignal.timeout(600_000), // 10 min — Deepseek can be very slow
    })

    const responseHeaders = new Headers(upstreamRes.headers)
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')

    // For requiresStreaming models on stream:true:
    // Transform the SSE (reasoning→content), tee it, forward one fork to openclaude,
    // and cache the assembled JSON for the follow-up stream:false request.
    if (isRequiresStreamingModel && !isNonStreamingRequest && upstreamRes.ok && upstreamRes.body && streamCacheKey) {
      const key = streamCacheKey
      const model = actualModel
      const transformed = upstreamRes.body.pipeThrough(createGroqCompoundTransform())
      const [streamA, streamB] = transformed.tee()
      sseToJson(streamB, model).then(json => {
        streamCache.set(key, { json, ts: Date.now() })
      }).catch(() => { /* non-critical */ })
      return new Response(streamA, { status: upstreamRes.status, headers: responseHeaders })
    }

    // For requiresStreaming models on stream:false (cache miss): convert SSE to JSON inline
    if (isNonStreamingRequest && upstreamRes.ok && upstreamRes.body) {
      const transformed = upstreamRes.body.pipeThrough(createGroqCompoundTransform())
      const json = await sseToJson(transformed, actualModel)
      responseHeaders.set('content-type', 'application/json')
      return new Response(JSON.stringify(json), { status: 200, headers: responseHeaders })
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: responseHeaders,
    })
  })

  return router
}
