import { Hono } from 'hono'
import { getAllProviders, getAllProviderKeys, loadPreferences, savePreferences } from '../services/config.js'
import { getModelInfo } from '../services/model.js'
import { listSessions, getSession } from '../services/session.js'
import { getActiveRunners, cancelRunner } from '../services/runner.js'
import type { TemperaturePreset } from '../../types/index.js'

const router = new Hono()

// ── In-memory session stats cache ─────────────────────────────────────────
// listSessions() + getSession() for each session can mean 200+ file reads/parses.
// Cache the expensive token/cost aggregation for 5 seconds.
let cache: {
  data: Record<string, unknown> | null
  ts: number
} = { data: null, ts: 0 }
const CACHE_TTL = 5_000

export function clearStatusCache(): void {
  cache = { data: null, ts: 0 }
}

router.get('/status', (c) => {
  const now = Date.now()
  if (cache.data && now - cache.ts < CACHE_TTL) {
    return c.json(cache.data)
  }
  const info = getModelInfo()
  const providers = getAllProviders()
  const keys = getAllProviderKeys()
  const sessions = listSessions()
  const activeRunners = getActiveRunners()

  // Strict check: only count keys the user explicitly saved via the UI
  // (provider_keys.json). The env-var fallback is for openclaude routing —
  // e.g. OPENAI_API_KEY in ~/.env aliases a Venice key, GEMINI/MISTRAL keys
  // may be inherited from shell startup files for unrelated tools. Treating
  // those as "configured" misleads the status bar.
  const keyHealth = Object.fromEntries(
    providers.map((p) => [p.id, { id: p.id, name: p.name, key_status: keys[p.id] ? 'green' : 'red' }])
  )

  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  for (const s of sessions) {
    const full = getSession(s.id)
    if (!full) continue
    for (const msg of full.messages) {
      totalInput += msg.input_tokens ?? 0
      totalOutput += msg.output_tokens ?? 0
      totalCost += msg.estimated_cost ?? 0
    }
  }

  const result = {
    model: info.current_model_id,
    providers: Object.values(keyHealth),
    session_count: sessions.length,
    active_runners: activeRunners,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cost: parseFloat(totalCost.toFixed(4)),
  }
  cache = { data: result as Record<string, unknown>, ts: Date.now() }
  return c.json(result)
})

router.get('/themes', (c) => {
  return c.json({
    themes: [
      { id: 'dark', name: 'Dark (Default)' },
      { id: 'amoled', name: 'AMOLED Pure Black' },
      { id: 'gruvbox', name: 'Gruvbox' },
      { id: 'nord', name: 'Nord' },
      { id: 'solarized', name: 'Solarized' },
    ],
  })
})

router.post('/restart', async (c) => {
  // Cancel all active openclaude runners (kill by tracked PID only — never pkill -f)
  const runnerIds = Object.keys(getActiveRunners())
  for (const sessionId of runnerIds) {
    cancelRunner(sessionId)
  }
  console.log(`[server] Restart: cancelled ${runnerIds.length} active runners`)

  // Clear the status cache so fresh data loads after restart
  clearStatusCache()

  // Return success — server stays alive, frontend refetches everything
  return c.json({
    status: 'restarted',
    message: `Cancelled ${runnerIds.length} runners, backend ready`,
  })
})

router.get('/preferences', (c) => {
  const prefs = loadPreferences()
  return c.json({
    default_system_prompt: prefs.default_system_prompt ?? '',
    default_temperature_preset: prefs.default_temperature_preset ?? null,
  })
})

router.post('/preferences', async (c) => {
  const body = await c.req.json<{
    default_system_prompt?: string
    default_temperature_preset?: TemperaturePreset | null
  }>().catch(() => ({}))
  const update: Record<string, unknown> = {}
  if ('default_system_prompt' in body) {
    update.default_system_prompt = body.default_system_prompt ?? ''
  }
  if ('default_temperature_preset' in body) {
    update.default_temperature_preset = body.default_temperature_preset ?? undefined
  }
  savePreferences(update)
  return c.json({ status: 'ok' })
})

router.post('/auth', async (c) => {
  const body = await c.req.json<{ token?: string }>().catch((): { token?: string } => ({}))
  const { getAuthToken } = await import('../services/config.js')
  const stored = getAuthToken()
  if (stored && body.token === stored) {
    return c.json({ ok: true, token: body.token })
  }
  if (!stored) {
    return c.json({ ok: true, token: '' })
  }
  return c.json({ error: 'Invalid token' }, 401)
})

export default router
