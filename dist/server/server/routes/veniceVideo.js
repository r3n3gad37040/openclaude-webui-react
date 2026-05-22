/**
 * Direct video generation endpoint for Venice models.
 * The frontend calls POST /api/venice/video with { model, prompt, duration?, aspect_ratio?, quality? }.
 * This bypasses the chat-completions proxy flow for cleaner video generation.
 */
import { Hono } from 'hono';
import { getProviderApiKey } from '../services/config.js';
import { saveBytesMedia } from '../services/media.js';
const VENICE_BASE = 'https://api.venice.ai/api/v1';
const router = new Hono();
router.post('/video', async (c) => {
    const apiKey = getProviderApiKey('venice');
    if (!apiKey)
        return c.json({ error: 'Venice API key not configured' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const model = body['model']?.trim();
    const prompt = body['prompt']?.trim();
    if (!model || !prompt)
        return c.json({ error: 'model and prompt are required' }, 400);
    const duration = body['duration'] ?? '8s';
    const aspect_ratio = body['aspect_ratio'] ?? '16:9';
    const resolution = resolveResolution(body['quality']);
    // 1. Queue the job
    const queueRes = await fetch(`${VENICE_BASE}/video/queue`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, duration, resolution, aspect_ratio }),
    });
    if (!queueRes.ok) {
        const err = await queueRes.text();
        return c.json({ error: `Venice video queue failed: ${queueRes.status} ${err.slice(0, 300)}` }, 502);
    }
    const queueData = (await queueRes.json());
    const queueId = queueData.queue_id;
    if (!queueId)
        return c.json({ error: 'Venice video queue returned no queue_id' }, 502);
    // 2. Poll for completion
    for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        const poll = await fetch(`${VENICE_BASE}/video/retrieve`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ queue_id: queueId, model }),
        });
        if (!poll.ok)
            continue;
        const ct = poll.headers.get('content-type') ?? '';
        if (ct.startsWith('video/')) {
            const bytes = new Uint8Array(await poll.arrayBuffer());
            const ext = ct.includes('webm') ? 'webm' : 'mp4';
            const { url } = saveBytesMedia(bytes, ext);
            return c.json({ url, media_type: 'video' });
        }
        const txt = await poll.text();
        try {
            const j = JSON.parse(txt);
            if (j.status === 'FAILED' || j.status === 'ERROR') {
                return c.json({ error: `Venice video failed: ${j.error ?? j.status}` }, 502);
            }
        }
        catch { /* keep polling */ }
    }
    return c.json({ error: 'Venice video generation timed out after 15 minutes' }, 504);
});
function resolveResolution(quality) {
    switch (quality?.toLowerCase()) {
        case 'low': return '480p';
        case 'medium': return '720p';
        case 'high': return '1080p';
        default: return '1080p';
    }
}
export default router;
// ── Image generation endpoint ───────────────────────────────────────────────
router.post('/image', async (c) => {
    const apiKey = getProviderApiKey('venice');
    if (!apiKey)
        return c.json({ error: 'Venice API key not configured' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const model = body['model']?.trim();
    const prompt = body['prompt']?.trim();
    if (!model || !prompt)
        return c.json({ error: 'model and prompt are required' }, 400);
    const aspect_ratio = body['aspect_ratio'] ?? '1:1';
    const width = body['width'] ?? 1024;
    const height = body['height'] ?? 1024;
    const res = await fetch(`${VENICE_BASE}/image/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, aspect_ratio, width, height }),
    });
    if (!res.ok) {
        const err = await res.text();
        return c.json({ error: `Venice image generation failed: ${res.status} ${err.slice(0, 300)}` }, 502);
    }
    const data = (await res.json());
    const img = data.images?.[0]?.image;
    if (!img)
        return c.json({ error: 'Venice returned no image' }, 502);
    const buf = Buffer.from(img, 'base64');
    const bytes = new Uint8Array(buf);
    const { url } = saveBytesMedia(bytes, 'png');
    return c.json({ url, media_type: 'image' });
});
