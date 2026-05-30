/**
 * Nous Research proxy — simple pass-through with identity stripping.
 * Nous API is OpenAI-compatible at https://api.nous.build/v1.
 */
import { Hono } from 'hono'

const NOUS_BASE = 'https://api.nous.build/v1'

function stripClaudeIdentity(systemContent: string, actualModel: string): string {
  let text = systemContent
  text = text.replace(/claude[-\s]*(sonnet|opus|haiku|instant)[-\s\d.]*/gi, actualModel)
  text = text.replace(/claude-sonnet[-\s\d.]*/gi, actualModel)
  text = text.replace(/You are Claude[^.]*\./gi, `You are ${actualModel} via Nous Research.`)
  text = text.replace(/made by Anthropic/gi, 'served via Nous Research')
  text = text.replace(/You are OpenClaude[^.]*\./gi, `You are ${actualModel} via Nous Research.`)
  text = text.replace(/\bOpenClaude\b/gi, actualModel)
  return text
}

const router = new Hono()

router.all('*', async (c) => {
  const urlObj = new URL(c.req.url)
  const relPath = urlObj.pathname.replace(/^\/nous-proxy/, '').replace(/^\/v1(?=\/)/, '')

  // Model-validation GET stub
  if (c.req.method === 'GET' && relPath.match(/^\/models\/(.+)$/)) {
    const modelId = decodeURIComponent(relPath.split('/').pop() ?? '')
    return c.json({ id: modelId, object: 'model' })
  }

  const targetUrl = `${NOUS_BASE}${relPath}${urlObj.search}`

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

  // Strip identity from system messages
  if (bodyText && relPath.includes('/chat/completions')) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>
      const actualModel = (parsed['model'] as string | undefined) ?? 'nous-model'
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
