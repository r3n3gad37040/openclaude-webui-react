import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import type { ServerType } from '@hono/node-server'
import { authMiddleware } from './middleware/auth.js'
import sessionRoutes from './routes/sessions.js'
import messageRoutes from './routes/messages.js'
import modelRoutes from './routes/models.js'
import statusRoutes from './routes/status.js'
import uploadRoutes from './routes/upload.js'
import mediaRoutes from './routes/media.js'
import openrouterProxy from './routes/openrouterProxy.js'
import veniceProxy from './routes/veniceProxy.js'
import xaiProxy from './routes/xaiProxy.js'
import groqProxy from './routes/groqProxy.js'
import dolphinProxy from './routes/dolphinProxy.js'
import nineteenProxy from './routes/nineteenProxy.js'
import anthropicProxy from './routes/anthropicProxy.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const PORT = parseInt(process.env['PORT'] ?? '8789')
const IS_PROD = process.env['NODE_ENV'] === 'production'
const DIST_DIR = join(process.cwd(), 'dist/ui')

const app = new Hono()

// ─── Security headers ─────────────────────────────────────────────────────
// CSP defends against XSS in markdown-rendered model output. The bundle
// loads ES modules + an external Google Fonts stylesheet so we have to
// allow those origins explicitly. SSE responses set their own headers so
// this middleware only applies to non-stream paths.
app.use('*', async (c, next) => {
  await next()
  // Don't override headers on SSE — Hono streamSSE manages its own.
  const ct = c.res.headers.get('content-type') ?? ''
  if (ct.includes('text/event-stream')) return
  c.res.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; '),
  )
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('Referrer-Policy', 'no-referrer')
  c.res.headers.set('X-Frame-Options', 'DENY')
})

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use(
  '/api/*',
  cors({
    origin: ['http://localhost:5173', 'http://localhost:8789', 'http://127.0.0.1:5173'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
)

// ─── Provider proxies — only reachable from localhost (server binds to
// 127.0.0.1 below). The local openclaude subprocess calls these. No
// per-request auth: the loopback bind is the gate. ───────────────────────
app.route('/or-proxy', openrouterProxy)
app.route('/venice-proxy', veniceProxy)
app.route('/xai-proxy', xaiProxy)
app.route('/groq-proxy', groqProxy)
app.route('/dolphin-proxy', dolphinProxy)
app.route('/nineteen-proxy', nineteenProxy)
app.route('/anthropic-proxy', anthropicProxy)

// Lightweight liveness probe — never does I/O. Mounted before the auth
// middleware so external supervisors can check without a token.
app.get('/api/healthz', (c) => c.json({ ok: true }))

// ─── Auth middleware on all /api routes except /api/auth ──────────────────
// Applied BEFORE the route handlers so upload/media/attachment endpoints
// (which used to be mounted before the middleware) are also gated.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/auth' || c.req.path === '/api/healthz') return next()
  return authMiddleware()(c, next)
})

// ─── API routes ────────────────────────────────────────────────────────────
app.route('/api', uploadRoutes)
app.route('/api', mediaRoutes)
app.route('/api/sessions', sessionRoutes)
// Message routes at both /api/sessions/:id/messages (RESTful) and /api/messages/:id/messages
app.route('/api/sessions', messageRoutes)
app.route('/api/messages', messageRoutes)
app.route('/api', modelRoutes)
app.route('/api', statusRoutes)

// In production, serve the built React app
if (IS_PROD && existsSync(DIST_DIR)) {
  app.use('/*', serveStatic({ root: './dist/ui' }))
  app.get('*', (c) => {
    const indexPath = join(DIST_DIR, 'index.html')
    if (existsSync(indexPath)) {
      return c.html(readFileSync(indexPath, 'utf-8'))
    }
    return c.text('Not found', 404)
  })
}

// ─── Server lifecycle ─────────────────────────────────────────────────────

let server: ServerType | null = null

// Bind loopback-only. Documented threat model is single-user local-only,
// and this gates all non-localhost traffic at the listener — defense in
// depth alongside the auth middleware on /api/*.
server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[server] OpenClaude API running on http://localhost:${info.port}`)
})

// ─── Graceful shutdown ────────────────────────────────────────────────────
// Close the listener so no new connections are accepted, give in-flight
// requests a few seconds to drain (active SSE streams especially), then
// exit. Previously SIGTERM dropped active streams immediately.
const SHUTDOWN_GRACE_MS = 5_000
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[server] ${signal} received, draining…`)
  if (server) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.log('[server] grace period elapsed, forcing exit')
        resolve()
      }, SHUTDOWN_GRACE_MS)
      server!.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
