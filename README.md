# OpenClaude Web UI

Multi-provider AI chat interface for the [openclaude](https://www.npmjs.com/package/@gitlawb/openclaude) CLI. React/Vite frontend, Hono backend, runs locally.

![Chat interface — Grok 4.3 multi-turn](docs/screenshots/chat-interface.png)

![Inline video generation — xAI grok-imagine-video](docs/screenshots/video-generation.png)

## Features

- **Native Anthropic mode** — Claude models route through openclaude's built-in Anthropic client (Claude Code OAuth or `ANTHROPIC_API_KEY`)
- **OpenAI-compat providers** — Venice.ai, OpenRouter, xAI, Groq, Mistral, Gemini, Moonshot, OpenAI, Dolphin, Nineteen, plus tool providers (Apify, Firecrawl)
- **Image generation** — xAI (`grok-imagine-image`), Venice (28 image models incl. flux/seedream/hidream), OpenRouter (Gemini-image, GPT-image)
- **Video generation** — xAI (`grok-imagine-video`), Venice (90+ video models incl. seedance/wan/kling/veo/sora-2)
- **Inline media rendering** — `<img>` and `<video controls>` rendered directly in chat bubbles
- **Type filter** — sidebar filter for Text / Image / Video / Audio models
- **Per-provider model discovery** — auto-fetches text + image + video + tts model lists per provider

## Setup

```bash
git clone https://github.com/<your-user>/openclaude-webui-react.git ~/openclaude-webui
cd ~/openclaude-webui
npm install
bash start.sh
```

Open http://localhost:5173 — first run will show empty key slots in Settings → API Keys. Add a key for any provider you want to use, click Save, then click the refresh icon next to the model picker to discover models.

## Architecture

- `src/server/` — Hono API on port 8789. Per-provider proxy routes strip the openclaude identity injection and route image/video models to provider-specific generation endpoints.
- `dist/ui/` — pre-built React/Vite bundle, served on port 5173 by `vite preview`. Vite proxies `/api/*` and `/<provider>-proxy/*` to the Hono server.
- State lives in `~/.openclaude-webui/state/` (sessions, models, provider keys) — never in this repo.

## Stop

```bash
bash stop.sh
```
