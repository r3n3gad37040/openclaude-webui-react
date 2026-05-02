/**
 * Anthropic proxy — accepts OpenAI-compatible requests from openclaude (CLAUDE_CODE_USE_OPENAI=1)
 * and translates them to Anthropic's native Messages API, returning OpenAI-compatible SSE.
 *
 * Why this exists: running openclaude in native Anthropic mode requires valid auth in
 * CLAUDE_CONFIG_DIR. If the key was ever rejected there, native mode silently exits with
 * no output. Routing through a proxy like every other provider avoids that entirely.
 */
import { Hono } from 'hono'

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 8192

// Translate Anthropic streaming SSE → OpenAI-compatible SSE chunks.
// Anthropic format: event: <type>\ndata: <json>\n\n
// We parse data lines only (type is also in the JSON) and emit OAI chunks.
function createAnthropicToOpenAITransform(model: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const id = `chatcmpl-anth-${Date.now()}`
  let buf = ''

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      let output = ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (!payload || payload === '[DONE]') continue

        try {
          const event = JSON.parse(payload) as Record<string, unknown>
          const evType = event['type'] as string

          if (evType === 'message_start') {
            const oaiChunk = {
              id, object: 'chat.completion.chunk', model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            }
            output += `data: ${JSON.stringify(oaiChunk)}\n\n`
          } else if (evType === 'content_block_delta') {
            const delta = event['delta'] as Record<string, unknown> | undefined
            if (delta?.['type'] === 'text_delta') {
              const text = delta['text'] as string
              if (text) {
                const oaiChunk = {
                  id, object: 'chat.completion.chunk', model,
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                }
                output += `data: ${JSON.stringify(oaiChunk)}\n\n`
              }
            }
          } else if (evType === 'message_stop') {
            const finishChunk = {
              id, object: 'chat.completion.chunk', model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            }
            output += `data: ${JSON.stringify(finishChunk)}\n\n`
            output += 'data: [DONE]\n\n'
          }
        } catch { /* skip malformed lines */ }
      }

      if (output) controller.enqueue(encoder.encode(output))
    },
    flush(controller) {
      if (buf) controller.enqueue(encoder.encode(buf))
    },
  })
}

const router = new Hono()

router.all('*', async (c) => {
  const urlObj = new URL(c.req.url)
  const relPath = urlObj.pathname.replace(/^\/anthropic-proxy/, '').replace(/^\/v1(?=\/)/, '')

  // Stub model-info GET so openclaude's validation passes
  const modelMatch = relPath.match(/^\/models\/(.+)$/)
  if (c.req.method === 'GET' && modelMatch) {
    const modelId = decodeURIComponent(modelMatch[1])
    return c.json({ id: modelId, object: 'model', owned_by: 'anthropic' })
  }

  if (!relPath.includes('/chat/completions')) {
    return c.json({ error: 'Unsupported endpoint' }, 400)
  }

  const bodyText = await c.req.text()
  const authHeader = c.req.header('authorization') ?? c.req.header('Authorization') ?? ''
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader

  if (!apiKey) {
    return c.json({ error: { message: 'No API key provided', type: 'auth_error' } }, 401)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
  }

  const model = (parsed['model'] as string | undefined) ?? 'claude-sonnet-4-6'
  const isStream = (parsed['stream'] as boolean | undefined) ?? false
  const messages = (parsed['messages'] as Array<Record<string, unknown>> | undefined) ?? []

  // Split system messages (Anthropic requires them in a separate `system` field)
  const systemMessages = messages.filter(m => m['role'] === 'system')
  const conversationMessages = messages.filter(m => m['role'] !== 'system')
  const systemContent = systemMessages.map(m => m['content'] as string).join('\n\n').trim()

  const anthropicBody: Record<string, unknown> = {
    model,
    messages: conversationMessages,
    max_tokens: (parsed['max_tokens'] as number | undefined) ?? DEFAULT_MAX_TOKENS,
    stream: isStream,
  }
  if (systemContent) {
    anthropicBody['system'] = systemContent
  }

  const anthropicHeaders = new Headers()
  anthropicHeaders.set('x-api-key', apiKey)
  anthropicHeaders.set('anthropic-version', ANTHROPIC_VERSION)
  anthropicHeaders.set('content-type', 'application/json')

  const upstreamRes = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: anthropicHeaders,
    body: JSON.stringify(anthropicBody),
  })

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text()
    return c.json(
      { error: { message: `Anthropic API error ${upstreamRes.status}: ${errText.slice(0, 300)}`, type: 'api_error' } },
      upstreamRes.status as 400 | 401 | 403 | 429 | 500
    )
  }

  if (isStream && upstreamRes.body) {
    const transformed = upstreamRes.body.pipeThrough(createAnthropicToOpenAITransform(model))
    return new Response(transformed, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  }

  // Non-streaming: translate Anthropic response → OpenAI format
  const anthropicResponse = await upstreamRes.json() as Record<string, unknown>
  const contentBlocks = anthropicResponse['content'] as Array<{ type: string; text?: string }> | undefined
  const textContent = contentBlocks?.filter(b => b.type === 'text').map(b => b.text ?? '').join('') ?? ''
  const usage = anthropicResponse['usage'] as { input_tokens: number; output_tokens: number } | undefined

  return c.json({
    id: `chatcmpl-anth-${Date.now()}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: textContent }, finish_reason: 'stop' }],
    usage: usage ? {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    } : undefined,
  })
})

export default router
