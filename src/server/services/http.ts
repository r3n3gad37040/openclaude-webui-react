import type { Context } from 'hono'

// Parse a JSON body, returning a typed empty object on parse failure or
// missing body. Replaces the repeated
// `c.req.json<T>().catch((): T => ({} as T))` boilerplate across routes.
export async function parseJson<T extends object>(c: Context): Promise<T> {
  try {
    return (await c.req.json<T>()) ?? ({} as T)
  } catch {
    return {} as T
  }
}

// 25 MB is well above any legitimate openclaude → upstream payload but well
// below "fill the heap with one request." Tune via env if a real workload
// pushes past it.
const DEFAULT_BODY_LIMIT = 25 * 1024 * 1024

export async function readBoundedText(
  c: Context,
  limit: number = DEFAULT_BODY_LIMIT,
): Promise<{ ok: true; text: string } | { ok: false; status: 413; reason: string }> {
  const cl = c.req.header('content-length')
  if (cl) {
    const n = Number(cl)
    if (Number.isFinite(n) && n > limit) {
      return { ok: false, status: 413, reason: `content-length ${n} exceeds ${limit}` }
    }
  }

  // Fall back to reading the body but cap memory by accumulating from the
  // raw request stream and bailing as soon as we cross the limit.
  const reader = c.req.raw.body?.getReader()
  if (!reader) return { ok: true, text: '' }
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      try { reader.cancel() } catch { /* ignore */ }
      return { ok: false, status: 413, reason: `body exceeded ${limit} bytes` }
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return { ok: true, text }
}
