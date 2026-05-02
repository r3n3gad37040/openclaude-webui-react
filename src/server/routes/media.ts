import { Hono } from 'hono'
import { readFileSync, existsSync, statSync } from 'fs'
import { join, basename, extname, resolve } from 'path'
import { homedir } from 'os'
import { MEDIA_DIR } from '../services/media.js'

const HOME = homedir()

// Allowed directories for media serving — expand as needed
const ALLOWED_ROOTS = [
  join(HOME, 'openclaude-webui', 'uploads'),
  join(HOME, '.hermes', 'audio_cache'),
  join(HOME, 'voice-memos'),
  join(HOME, 'Pictures'),
  join(HOME, 'Downloads'),
  MEDIA_DIR,
  '/tmp',
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

// GET /api/media/serve?path=/absolute/path/to/file
// Serves media files from allowed directories only.
router.get('/media/serve', (c) => {
  const rawPath = c.req.query('path')
  if (!rawPath) return c.json({ error: 'Missing path parameter' }, 400)

  const safePath = isPathSafe(rawPath)
  if (!safePath) return c.json({ error: 'Access denied — path not in allowed directories' }, 403)

  if (!existsSync(safePath)) return c.json({ error: 'File not found' }, 404)

  const ext = extname(safePath).toLowerCase()
  const contentType = MIME_MAP[ext] ?? 'application/octet-stream'

  try {
    const stat = statSync(safePath)
    const data = readFileSync(safePath)

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Cache-Control': 'public, max-age=3600',
      'Accept-Ranges': 'bytes',
    }

    // For videos, support range requests
    const range = c.req.header('Range')
    if (range && (contentType.startsWith('video/') || contentType.startsWith('audio/'))) {
      const parts = range.replace('bytes=', '').split('-')
      const start = parseInt(parts[0] ?? '0', 10)
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
      const chunkSize = end - start + 1

      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
      headers['Content-Length'] = String(chunkSize)

      return new Response(data.subarray(start, end + 1), {
        status: 206,
        headers,
      })
    }

    return new Response(data, { headers })
  } catch {
    return c.json({ error: 'Error reading file' }, 500)
  }
})

// GET /api/media/serve/:name — serve by filename from uploads dir (shortcut)
router.get('/media/serve/:name', (c) => {
  const name = basename(c.req.param('name'))
  const filePath = join(HOME, 'openclaude-webui', 'uploads', name)
  if (!existsSync(filePath)) return c.json({ error: 'Not found' }, 404)

  const ext = extname(name).toLowerCase()
  const contentType = MIME_MAP[ext] ?? 'application/octet-stream'
  const data = readFileSync(filePath)
  return new Response(data, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    },
  })
})

export default router
