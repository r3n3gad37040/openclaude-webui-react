import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { STATE_DIR } from './config.js'

export const MEDIA_DIR = join(STATE_DIR, 'media')
mkdirSync(MEDIA_DIR, { recursive: true })

// Detects content from base64-decoded magic bytes when the caller doesn't know the format.
function sniffExt(base64: string): string {
  const head = base64.slice(0, 16)
  if (head.startsWith('iVBORw')) return 'png'           // PNG
  if (head.startsWith('/9j/') || head.startsWith('/9k')) return 'jpg'  // JPEG
  if (head.startsWith('UklGR')) return 'webp'           // WebP (RIFF)
  if (head.startsWith('R0lGOD')) return 'gif'           // GIF
  if (head.startsWith('AAAAI') || head.startsWith('AAAAH')) return 'mp4'
  return 'bin'
}

// Saves a base64-encoded media blob to STATE_DIR/media and returns an
// /api/media/serve URL the frontend can fetch directly.
export function saveBase64Media(base64: string, ext?: string): { path: string; url: string } {
  const cleaned = base64.replace(/^data:[^;]+;base64,/, '')
  const finalExt = ext ?? sniffExt(cleaned)
  const filename = `${randomUUID()}.${finalExt}`
  const path = join(MEDIA_DIR, filename)
  writeFileSync(path, Buffer.from(cleaned, 'base64'))
  return { path, url: `/api/media/serve?path=${encodeURIComponent(path)}` }
}

// Same as saveBase64Media but for raw binary (e.g. Venice video returns mp4 bytes).
export function saveBytesMedia(bytes: Uint8Array, ext: string): { path: string; url: string } {
  const filename = `${randomUUID()}.${ext}`
  const path = join(MEDIA_DIR, filename)
  writeFileSync(path, bytes)
  return { path, url: `/api/media/serve?path=${encodeURIComponent(path)}` }
}
