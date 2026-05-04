import { Hono } from 'hono'
import { existsSync, createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { join, basename, extname, resolve } from 'path'
import { homedir } from 'os'
import { Readable } from 'stream'
import { MEDIA_DIR } from '../services/media.js'

const HOME = homedir()

// Allowed directories for media serving. Kept narrow on purpose: only the
// webui's own upload + generated-media directories. Previously included
// ~/Pictures, ~/Downloads, /tmp, and ~/.hermes/audio_cache, which let
// authenticated callers read arbitrary files in those trees by guessing
// names — too broad even for a single-user local app.
const ALLOWED_ROOTS = [
  join(HOME, 'openclaude-webui', 'uploads'),
  MEDIA_DIR,
]

function isPathSafe(requested: string): string | null {
  const resolved = resolve(requested)
  for (const root of ALLOWED_ROOTS) {
    const resolvedRoot = resolve(root)
    if (resolved.startsWith(resolvedRoot + '/') || resolved === resolvedRoot) {
      return resolved
    }
  }
  return null
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
}

const router = new Hono()

// Stream a file (or range slice) without loading it into memory. Previously
// used readFileSync — a 1 GB video served via a small range request still
// loaded the entire 1 GB. createReadStream({ start, end }) seeks instead.
function streamFile(filePath: string, contentType: string, totalSize: number, range?: string): Response {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
    'Accept-Ranges': 'bytes',
  }

  if (range && (contentType.startsWith('video/') || contentType.startsWith('audio/'))) {
    const parts = range.replace('bytes=', '').split('-')
    const start = parseInt(parts[0] ?? '0', 10)
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end >= totalSize || start > end) {
      return new Response('Invalid range', { status: 416, headers: { 'Content-Range': `bytes */${totalSize}` } })
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`
    headers['Content-Length'] = String(end - start + 1)
    const node = createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(node) as ReadableStream, { status: 206, headers })
  }

  headers['Content-Length'] = String(totalSize)
  const node = createReadStream(filePath)
  return new Response(Readable.toWeb(node) as ReadableStream, { headers })
}

// GET /api/media/serve?path=/absolute/path/to/file
// Serves media files from allowed directories only.
router.get('/media/serve', async (c) => {
  const rawPath = c.req.query('path')
  if (!rawPath) return c.json({ error: 'Missing path parameter' }, 400)

  const safePath = isPathSafe(rawPath)
  if (!safePath) return c.json({ error: 'Access denied — path not in allowed directories' }, 403)
  if (!existsSync(safePath)) return c.json({ error: 'File not found' }, 404)

  try {
    const st = await stat(safePath)
    const ext = extname(safePath).toLowerCase()
    const contentType = MIME_MAP[ext] ?? 'application/octet-stream'
    return streamFile(safePath, contentType, st.size, c.req.header('Range'))
  } catch (err) {
    process.stderr.write(`[media] serve(${safePath}) failed: ${err}\n`)
    return c.json({ error: 'Error reading file' }, 500)
  }
})

// GET /api/media/serve/:name — serve by filename from uploads dir (shortcut)
router.get('/media/serve/:name', async (c) => {
  const name = basename(c.req.param('name'))
  const filePath = join(HOME, 'openclaude-webui', 'uploads', name)
  if (!existsSync(filePath)) return c.json({ error: 'Not found' }, 404)
  try {
    const st = await stat(filePath)
    const ext = extname(name).toLowerCase()
    const contentType = MIME_MAP[ext] ?? 'application/octet-stream'
    return streamFile(filePath, contentType, st.size, c.req.header('Range'))
  } catch (err) {
    process.stderr.write(`[media] serve(${filePath}) failed: ${err}\n`)
    return c.json({ error: 'Error reading file' }, 500)
  }
})

export default router
