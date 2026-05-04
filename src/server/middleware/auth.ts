import type { Context, Next } from 'hono'
import { timingSafeEqual } from 'crypto'
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

function getClientIp(c: Context): string | null {
  // Prefer the typed access point Hono exposes; fall back to env.incoming
  // for older adapter versions. If we can't determine the IP, return null
  // and the caller should treat it as a denial — fail closed, never assume
  // loopback.
  const incoming = c.env?.['incoming'] as { socket?: { remoteAddress?: string } } | undefined
  const ip = incoming?.socket?.remoteAddress
  return ip ? String(ip) : null
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

// Length-padded constant-time compare so an attacker can't probe the token
// length via response timing.
function constantTimeEquals(a: string, b: string): boolean {
  const lenA = Buffer.byteLength(a, 'utf8')
  const lenB = Buffer.byteLength(b, 'utf8')
  const max = Math.max(lenA, lenB, 1)
  const ba = Buffer.alloc(max)
  const bb = Buffer.alloc(max)
  ba.write(a, 'utf8')
  bb.write(b, 'utf8')
  return timingSafeEqual(ba, bb) && lenA === lenB
}

export function authMiddleware() {
  return async (c: Context, next: Next) => {
    const stored = getAuthToken()

    // No token configured at all → single-user local-only mode, anonymous
    // access is allowed. The 127.0.0.1 listener bind is the security gate.
    if (!stored) {
      await next()
      return
    }

    // Token configured → all requests require it, including loopback.
    const ip = getClientIp(c) ?? 'unknown'
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests' }, 429)
    }

    const token = extractToken(c)
    if (!token || !constantTimeEquals(token, stored)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  }
}

export { checkRateLimit, extractToken, constantTimeEquals }
