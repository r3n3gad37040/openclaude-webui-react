import type { Context } from 'hono'

/** Safely parse JSON from a Hono request context, returning typed defaults on failure. */
export async function safeJson<T>(c: Context, fallback: T): Promise<T> {
  try {
    return await c.req.json() as T
  } catch {
    return fallback
  }
}

/** Like safeJson but without a fallback — returns the parsed result or the generic empty object. */
export async function parseJson<T extends Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return await c.req.json()
  } catch {
    return {} as unknown as T
  }
}
