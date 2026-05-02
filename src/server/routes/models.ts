import { Hono } from 'hono'
import {
  getAllProviders,
  getConfiguredModels,
  getModelsByProvider,
  getCurrentPrimaryModel,
  getAllProviderKeys,
  setProviderApiKey,
} from '../services/config.js'
import { getModelInfo, switchModel, discoverAndSaveModels } from '../services/model.js'
import { updateSessionModelId } from '../services/session.js'

const router = new Hono()

router.get('/providers', (c) => {
  return c.json({ providers: getAllProviders() })
})

router.get('/models', (c) => {
  const provider = c.req.query('provider')
  const models = provider ? getModelsByProvider(provider) : getConfiguredModels()
  const current = getCurrentPrimaryModel()
  const [currentProvider, ...rest] = current.split('/')
  const currentModel = rest.join('/')
  return c.json({
    models,
    current,
    current_model: currentModel,
    current_provider: currentProvider ?? '',
  })
})

router.get('/model', (c) => {
  return c.json(getModelInfo())
})

router.post('/switch-model', async (c) => {
  const body = await c.req
    .json<{ provider?: string; model?: string; api_key?: string; discover?: boolean; session_id?: string }>()
    .catch(() => ({}))

  const provider = (body.provider ?? '').trim().toLowerCase()
  const model = (body.model ?? '').trim()
  const apiKey = body.api_key?.trim() || undefined
  const discover = body.discover ?? false
  const sessionId = body.session_id?.trim() || undefined

  if (!provider || !model) return c.json({ error: 'Provider and model are required' }, 400)

  const result = await switchModel(provider, model, apiKey, discover)
  if (result.status === 'error') return c.json({ error: result.error }, 400)

  // Update the active session's model_id so the very next message routes to the new provider
  if (sessionId && result.model_id) {
    await updateSessionModelId(sessionId, result.model_id)
  }

  return c.json(result)
})

router.post('/discover-models', async (c) => {
  const body = await c.req
    .json<{ provider?: string; api_key?: string }>()
    .catch(() => ({}))

  const provider = (body.provider ?? '').trim().toLowerCase()
  const apiKey = body.api_key?.trim() || undefined

  if (!provider) return c.json({ error: 'Provider is required' }, 400)

  const models = await discoverAndSaveModels(provider, apiKey)
  return c.json({ status: 'ok', provider, count: models.length, models })
})

router.get('/provider_keys', (c) => {
  const keys = getAllProviderKeys()
  const masked = Object.fromEntries(
    Object.entries(keys).map(([p, k]) => [
      p,
      { has_key: true, last4: k.length > 4 ? k.slice(-4) : '****' },
    ])
  )
  return c.json({ keys: masked })
})

router.post('/provider_keys', async (c) => {
  const body = await c.req
    .json<{ provider?: string; api_key?: string }>()
    .catch(() => ({}))

  const provider = (body.provider ?? '').trim().toLowerCase()
  const apiKey = (body.api_key ?? '').trim()

  if (!provider || !apiKey) return c.json({ error: 'Provider and api_key are required' }, 400)

  setProviderApiKey(provider, apiKey)
  return c.json({ status: 'ok', provider })
})

export default router
