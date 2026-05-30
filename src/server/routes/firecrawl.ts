/**
 * Firecrawl v2.10 API proxy — exposes new endpoints to the web UI frontend.
 *
 * Endpoints:
 *   POST /api/firecrawl/scrape     — scrape with lockdown, question, highlights, video
 *   POST /api/firecrawl/parse      — upload local files (PDF/DOCX/XLSX/HTML etc.) up to 50 MB
 *   POST /api/firecrawl/search     — search with includeDomains / excludeDomains
 *   POST /api/firecrawl/search/:jobId/feedback  — rate a search result, get credit refund
 *   POST /api/firecrawl/crawl      — crawl with custom robotsUserAgent
 *   POST /api/firecrawl/map        — map URLs from a base URL
 *   GET  /api/firecrawl/status/:id  — poll crawl / search job status
 *
 * Auth: reads FIRECRAWL_API_KEY from provider_keys.json or env.
 * Base URL: configurable via FIRECRAWL_BASE_URL (default https://api.firecrawl.dev/v1).
 */
import { Hono } from 'hono'
import { getProviderApiKey } from '../services/config.js'
import { parseJson } from '../services/http.js'

const router = new Hono()

const FIRECRAWL_BASE_URL = (process.env['FIRECRAWL_BASE_URL'] ?? 'https://api.firecrawl.dev/v1').replace(/\/$/, '')

function getApiKey(): string | null {
  return getProviderApiKey('firecrawl')
}

function authHeaders(): Record<string, string> {
  const key = getApiKey()
  if (!key) return {}
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

function firecrawlError(status: number, detail: string): Response {
  return new Response(
    JSON.stringify({ success: false, error: detail }),
    { status, headers: { 'Content-Type': 'application/json' } }
  )
}

// ─── Scrape ────────────────────────────────────────────────────────────────
// Supports v2.10 formats: markdown, html, screenshot, links, question,
// highlights, video. Plus lockdown mode.
router.post('/scrape', async (c) => {
  const key = getApiKey()
  if (!key) return firecrawlError(401, 'Firecrawl API key not configured')

  const body = await parseJson<{
    url?: string
    formats?: string[]
    onlyMainContent?: boolean
    includeTags?: string[]
    excludeTags?: string[]
    headers?: Record<string, string>
    waitFor?: number
    timeout?: number
    mobile?: boolean
    skipTlsVerification?: boolean
    removeBase64Images?: boolean
    actions?: unknown[]
    location?: { country?: string; languages?: string[] }
    proxy?: 'auto' | 'basic' | 'stealth'
    // v2.10 additions
    lockdown?: boolean
  }>(c)

  if (!body.url) return firecrawlError(400, 'url is required')

  const res = await fetch(`${FIRECRAWL_BASE_URL}/scrape`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON from Firecrawl' }))
  return c.json(data, res.status as any)
})

// ─── Parse (local file upload) ───────────────────────────────────────────
// v2.10: upload PDF/DOCX/DOC/ODT/RTF/XLSX/XLS/HTML up to 50 MB.
// We accept multipart/form-data from the frontend and forward it.
router.post('/parse', async (c) => {
  const key = getApiKey()
  if (!key) return firecrawlError(401, 'Firecrawl API key not configured')

  const form = await c.req.formData()
  const file = form.get('file')
  if (!file || !(file instanceof File)) {
    return firecrawlError(400, 'file is required (multipart/form-data)')
  }

  // Build a new FormData to forward cleanly
  const forward = new FormData()
  forward.append('file', file, file.name)

  const res = await fetch(`${FIRECRAWL_BASE_URL}/parse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: forward,
  })

  const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON from Firecrawl' }))
  return c.json(data, res.status as any)
})

// ─── Search ────────────────────────────────────────────────────────────────
// v2.10: includeDomains / excludeDomains filters.
router.post('/search', async (c) => {
  const key = getApiKey()
  if (!key) return firecrawlError(401, 'Firecrawl API key not configured')

  const body = await parseJson<{
    query?: string
    limit?: number
    lang?: string
    country?: string
    tbs?: string
    // v2.10 additions
    includeDomains?: string[]
    excludeDomains?: string[]
  }>(c)

  if (!body.query) return firecrawlError(400, 'query is required')

  const res = await fetch(`${FIRECRAWL_BASE_URL}/search`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON from Firecrawl' }))
  return c.json(data, res.status as any)
})

// ─── Search feedback ───────────────────────────────────────────────────────
// v2.10: rate a search result, get 1 credit refund (capped per UTC day).
router.post('/search/:jobId/feedback', async (c) => {
  const key = getApiKey()
  if (!key) return firecrawlError(401, 'Firecrawl API key not configured')

  const jobId = c.req.param('jobId')
  const body = await parseJson<{
    rating?: number          // 1-5
    comment?: string
    resultIndex?: number
  }>(c)

  if (typeof body.rating !== 'number') return firecrawlError(400, 'rating is required')

  const res = await fetch(`${FIRECRAWL_BASE_URL}/search/${encodeURIComponent(jobId)}/feedback`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON from Firecrawl' }))
  return c.json(data, res.status as any)
})

// ─── Crawl ─────────────────────────────────────────────────────────────────
// v2.10: robotsUserAgent in crawlerOptions.
router.post('/crawl', async (c) => {
  const key = getApiKey()
  if (!key) return firecrawlError(401, 'Firecrawl API key not configured')

  const body = await parseJson<{
    url?: string
    excludePaths?: string[]
    includePaths?: string[]
    maxDepth?: number
    limit?: number
    allowBackwardLinks?: boolean
    allowExternalLinks?: boolean
    webhook?: string
    idempotencyKey?: string
    scrapeOptions?: Record<string, unknown>
    // v2.10 additions
    crawlerOptions?: {
      robotsUserAgent?: string
      ignoreRobots?: boolean | 'disabled' | 'allowed' | 'forced'
      [k: string]: unknown
    }
  }>(c)

  if (!body.url) return firecrawlError(400, 'url is required')

  const res = await fetch(`${FIRECRAWL_BASE_URL}/crawl`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON from Firecrawl' }))
  return c.json(data, res.status as any)
})

// ─── Map ─────────────────────────────────────────────────────────────────
router.post('/map', async (c) => {
  const key = getApiKey()
  if (!key) return firecrawlError(401, 'Firecrawl API key not configured')

  const body = await parseJson<{
    url?: string
    search?: string
    ignoreSitemap?: boolean
    limit?: number
    sitemapOnly?: boolean
    includeSubdomains?: boolean
  }>(c)

  if (!body.url) return firecrawlError(400, 'url is required')

  const res = await fetch(`${FIRECRAWL_BASE_URL}/map`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON from Firecrawl' }))
  return c.json(data, res.status as any)
})

// ─── Status (poll crawl / search jobs) ───────────────────────────────────
router.get('/status/:id', async (c) => {
  const key = getApiKey()
  if (!key) return firecrawlError(401, 'Firecrawl API key not configured')

  const id = c.req.param('id')
  const res = await fetch(`${FIRECRAWL_BASE_URL}/crawl/status/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
  })

  // Fall back to search status if crawl status 404s
  if (res.status === 404) {
    const searchRes = await fetch(`${FIRECRAWL_BASE_URL}/search/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    const searchData = await searchRes.json().catch(() => ({ success: false, error: 'Invalid JSON from Firecrawl' }))
    return c.json(searchData, searchRes.status as any)
  }

  const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON from Firecrawl' }))
  return c.json(data, res.status as any)
})

// ─── Batch scrape (convenience) ──────────────────────────────────────────
router.post('/batch/scrape', async (c) => {
  const key = getApiKey()
  if (!key) return firecrawlError(401, 'Firecrawl API key not configured')

  const body = await parseJson<{
    urls?: string[]
    formats?: string[]
    onlyMainContent?: boolean
    includeTags?: string[]
    excludeTags?: string[]
    headers?: Record<string, string>
    waitFor?: number
    timeout?: number
    mobile?: boolean
    skipTlsVerification?: boolean
    removeBase64Images?: boolean
    actions?: unknown[]
    location?: { country?: string; languages?: string[] }
    proxy?: 'auto' | 'basic' | 'stealth'
    lockdown?: boolean
  }>(c)

  if (!body.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
    return firecrawlError(400, 'urls array is required')
  }

  const res = await fetch(`${FIRECRAWL_BASE_URL}/batch/scrape`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({ success: false, error: 'Invalid JSON from Firecrawl' }))
  return c.json(data, res.status as any)
})

export default router
