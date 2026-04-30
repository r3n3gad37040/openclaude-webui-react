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
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const PORT = parseInt(process.env['PORT'] ?? '8789')
const IS_PROD = process.env['NODE_ENV'] === 'production'
const DIST_DIR = join(process.cwd(), 'dist/ui')

const app = new Hono()

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

// ─── Provider proxies (no auth — openclaude calls these directly) ────────
app.route('/or-proxy', openrouterProxy)
app.route('/venice-proxy', veniceProxy)
app.route('/xai-proxy', xaiProxy)
app.route('/groq-proxy', groqProxy)
app.route('/dolphin-proxy', dolphinProxy)
app.route('/nineteen-proxy', nineteenProxy)

// ─── Attachment serving (no auth needed — single-user local app) ─────────
app.route('/api', uploadRoutes)
app.route('/api', mediaRoutes)

// ─── Auth middleware on all /api routes except /api/auth ──────────────────
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/auth') return next()
  return authMiddleware()(c, next)
})

// ─── API routes ────────────────────────────────────────────────────────────
app.route('/api/sessions', sessionRoutes)
// Message routes at both /api/sessions/:id/messages (RESTful) and /api/messages/:id/messages
app.route('/api/sessions', messageRoutes)
app.route('/api/messages', messageRoutes)
app.route('/api', modelRoutes)
app.route('/api', statusRoutes)
app.route('/api', uploadRoutes)

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

// ─── Server lifecycle — restartable without process death ────────────────

let server: ServerType | null = null

export function getServer(): ServerType | null {
  return server
}

export async function restartServer(): Promise<void> {
  // Close the existing server if running
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => {
        console.log('[server] Old server closed')
        resolve()
      })
    })
    // Give the OS a moment to release the port
    await new Promise((r) => setTimeout(r, 100))
  }

  // Start a fresh server on the same port
  server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[server] OpenClaude API running on http://localhost:${info.port}`)
  })
}

// ─── Start ────────────────────────────────────────────────────────────────

void restartServer()

// ─── Graceful shutdown ────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received, shutting down...')
  process.exit(0)
})
process.on('SIGINT', () => {
  console.log('[server] SIGINT received, shutting down...')
  process.exit(0)
})
