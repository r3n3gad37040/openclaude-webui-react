import { Hono } from 'hono'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join, basename, extname } from 'path'
import { homedir } from 'os'

const UPLOADS_DIR = join(homedir(), 'openclaude-webui', 'uploads')
mkdirSync(UPLOADS_DIR, { recursive: true })

const MAX_TOTAL_UPLOAD_BYTES = 200 * 1024 * 1024  // 200 MB total per request
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024       // 50 MB per file

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv',
}

const router = new Hono()

router.get('/attachments/:name', (c) => {
  const name = basename(c.req.param('name'))
  const filePath = join(UPLOADS_DIR, name)
  if (!existsSync(filePath)) return c.json({ error: 'Not found' }, 404)
  const ext = extname(name).toLowerCase()
  const contentType = MIME_MAP[ext] ?? 'application/octet-stream'
  const data = readFileSync(filePath)
  return new Response(data, { headers: { 'Content-Type': contentType } })
})

router.post('/upload', async (c) => {
  const formData = await c.req.formData().catch(() => null)
  if (!formData) return c.json({ error: 'Invalid form data' }, 400)

  const uploaded: Array<{ name: string; path: string; size: number }> = []

  const entries = [...formData.entries()]
  let totalSize = 0

  // First pass: validate all files before writing any
  for (const [field, value] of entries) {
    if (field !== 'files' || !(value instanceof File)) continue
    totalSize += value.size
    if (value.size > MAX_FILE_SIZE_BYTES) {
      return c.json({ error: `File too large: ${value.name} (max ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB)` }, 400)
    }
  }

  if (totalSize > MAX_TOTAL_UPLOAD_BYTES) {
    return c.json({ error: `Total upload size ${(totalSize / 1024 / 1024).toFixed(0)} MB exceeds ${MAX_TOTAL_UPLOAD_BYTES / 1024 / 1024} MB limit` }, 400)
  }

  // Second pass: write files
  for (const [field, value] of entries) {
    if (field !== 'files' || !(value instanceof File)) continue

    const safeName = basename(value.name) || `upload_${Date.now()}`
    let dest = join(UPLOADS_DIR, safeName)
    let counter = 1
    const ext = safeName.includes('.') ? `.${safeName.split('.').pop()}` : ''
    const stem = safeName.slice(0, safeName.length - ext.length)
    while (existsSync(dest)) {
      dest = join(UPLOADS_DIR, `${stem}_${counter}${ext}`)
      counter++
    }

    const buf = await value.arrayBuffer()
    writeFileSync(dest, Buffer.from(buf))
    uploaded.push({ name: basename(dest), path: dest, size: value.size })
  }

  return c.json({ status: 'ok', files: uploaded })
})

export default router
