import { Hono } from 'hono'
import {
  listSessions,
  getSession,
  createSession,
  deleteSession,
  renameSession,
  searchSessions,
  exportSession,
  deleteMessage,
  truncateMessagesFrom,
  updateSessionMeta,
  importSession,
  updateSessionModelId,
} from '../services/session.js'
import { parseJson } from '../utils/json.js'
import { getCurrentPrimaryModel, loadPreferences } from '../services/config.js'

const router = new Hono()

router.get('/', (c) => {
  const q = c.req.query('q')
  if (q) {
    return c.json({ sessions: searchSessions(q) })
  }
  return c.json({ sessions: listSessions() })
})

router.post('/', async (c) => {
  const body = await parseJson<{ model_id?: string; title?: string; system_prompt?: string; temperature_preset?: string }>(c)
  const modelId = body.model_id ?? getCurrentPrimaryModel()
  if (!modelId) return c.json({ error: 'No model selected' }, 400)
  const prefs = loadPreferences()
  const session = createSession(modelId, body.title, {
    system_prompt: body.system_prompt ?? prefs.default_system_prompt ?? undefined,
    temperature_preset: (body.temperature_preset ?? prefs.default_temperature_preset) as 'precise' | 'balanced' | 'creative' | undefined,
  })
  return c.json({ session, id: session.id })
})

router.post('/import', async (c) => {
  const body = await parseJson<Record<string, unknown>>(c)
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid session data' }, 400)
  try {
    const session = await importSession(body as never)
    return c.json({ session, id: session.id })
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400)
  }
})

router.get('/:id', (c) => {
  const session = getSession(c.req.param('id'))
  if (!session) return c.json({ error: 'Session not found' }, 404)
  c.header('Cache-Control', 'no-store')
  return c.json({ session, messages: session.messages, model_id: session.model_id })
})

router.delete('/:id', (c) => {
  const ok = deleteSession(c.req.param('id'))
  if (!ok) return c.json({ error: 'Session not found' }, 404)
  return c.json({ status: 'ok' })
})

router.post('/:id/rename', async (c) => {
  const body = await parseJson<{ title: string }>(c)
  if (!body.title) return c.json({ error: 'Title is required' }, 400)
  const session = await renameSession(c.req.param('id'), body.title)
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({ status: 'ok', title: session.title })
})

router.get('/:id/export', (c) => {
  const format = (c.req.query('format') ?? 'markdown') as 'json' | 'markdown'
  const id = c.req.param('id')
  const content = exportSession(id, format)
  if (!content) return c.json({ error: 'Session not found' }, 404)

  if (format === 'json') {
    return new Response(content, {
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${id.slice(0, 8)}.json"` },
    })
  }
  return new Response(content, {
    headers: { 'Content-Type': 'text/markdown', 'Content-Disposition': `attachment; filename="${id.slice(0, 8)}.md"` },
  })
})

router.post('/:id/delete-message', async (c) => {
  const body = await parseJson<{ index: number }>(c)
  if (body.index === undefined) return c.json({ error: 'Message index is required' }, 400)
  const ok = await deleteMessage(c.req.param('id'), body.index)
  if (!ok) return c.json({ error: 'Delete failed' }, 400)
  return c.json({ status: 'ok' })
})

router.post('/:id/truncate', async (c) => {
  const body = await parseJson<{ from_index: number }>(c)
  if (body.from_index === undefined) return c.json({ error: 'from_index is required' }, 400)
  const ok = await truncateMessagesFrom(c.req.param('id'), body.from_index)
  if (!ok) return c.json({ error: 'Truncate failed' }, 400)
  return c.json({ status: 'ok' })
})

router.post('/:id/meta', async (c) => {
  const body = await parseJson<{ system_prompt?: string | null; temperature_preset?: string | null }>(c)
  const session = await updateSessionMeta(c.req.param('id'), {
    ...(('system_prompt' in body) ? { system_prompt: body.system_prompt ?? undefined } : {}),
    ...(('temperature_preset' in body) ? { temperature_preset: body.temperature_preset as 'precise' | 'balanced' | 'creative' | null } : {}),
  })
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json({ status: 'ok', session })
})

export default router
