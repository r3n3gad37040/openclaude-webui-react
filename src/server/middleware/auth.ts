import type { Context, Next } from 'hono'
import { getAuthToken } from '../services/config.js'

const rateLimits = new Map<string, number[]>()
const WINDOW = 60_000
const MAX_ATTEMPTS = 20

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const attempts = (rateLimits.get(ip) ?? []).filter((t) => now - t < WINDOW)
  if (attempts.length >= MAX_ATTEMPTS) return false
  attempts.push(now)
  rateLimits.set(ip, attempts)
  return true
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

function extractToken(c: Context): string {
  const auth = c.req.header('Authorization') ?? ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  const cookie = c.req.header('Cookie') ?? ''
  for (const part of cookie.split(';')) {
    const t = part.trim()
    if (t.startsWith('oc_auth_token=')) return t.slice('oc_auth_token='.length)
  }
  return ''
}

export function authMiddleware() {
  return async (c: Context, next: Next) => {
    const incoming = c.env?.['incoming'] as { socket?: { remoteAddress?: string } } | undefined
    const ip = incoming?.socket?.remoteAddress ?? '127.0.0.1'

    if (isLoopback(String(ip))) {
      await next()
      return
    }

    if (!checkRateLimit(String(ip))) {
      return c.json({ error: 'Too many requests' }, 429)
    }

    const token = extractToken(c)
    const stored = getAuthToken()

    if (!stored || token !== stored) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  }
}

export { checkRateLimit, isLoopback, extractToken }
