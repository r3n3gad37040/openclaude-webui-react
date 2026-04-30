import { createGenericProxy } from './proxyFactory.js'

export default createGenericProxy({
  pathPrefix: 'groq-proxy',
  baseUrl: 'https://api.groq.com/openai/v1',
  providerName: 'Groq',
  defaultModel: 'llama3-8b-8192',
  ownedBy: 'groq',
  maxOutputTokens: 8192,
  noToolsPatterns: [
    /compound/i,
    /whisper/i,
    /orpheus/i,
    /prompt-guard/i,
    /safeguard/i,
  ],
  // Groq Compound requires stream:true — non-streaming requests get 413.
  // The proxy forces stream:true and converts SSE back to JSON for callers expecting non-streaming.
  requiresStreamingPatterns: [
    /compound/i,
  ],
})
