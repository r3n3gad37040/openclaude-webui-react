// Shared utility — strip openclaude's injected Claude/OpenClaude identity
// from system prompts before forwarding to a non-Anthropic provider.
//
// The regex set is deliberately narrow: only phrases openclaude actually
// injects ("You are Claude…", "made by Anthropic", "You are OpenClaude…").
// We do NOT bare-substitute every occurrence of "Claude" or "OpenClaude" —
// the previous implementation did, and it corrupted legitimate user
// questions like "What's the difference between Claude Sonnet and GPT-4?".

const INJECTED_PATTERNS: Array<[RegExp, (model: string, provider: string) => string]> = [
  // openclaude ≤0.6.x identity preamble
  [/You are Claude[^.]*\./gi, (m, p) => `You are ${m} via ${p}.`],
  [/I am Claude[^.]*\./gi, (m, p) => `I am ${m} via ${p}.`],
  // openclaude ≥0.7.0 identity preamble
  [/You are OpenClaude[^.]*\./gi, (m, p) => `You are ${m} via ${p}.`],
  [/I am OpenClaude[^.]*\./gi, (m, p) => `I am ${m} via ${p}.`],
  // Provenance phrases
  [/made by Anthropic/gi, (_, p) => `served via ${p}`],
  [/created by Anthropic/gi, (_, p) => `served via ${p}`],
]

export function stripInjectedIdentity(systemContent: string, actualModel: string, providerName: string): string {
  let text = systemContent
  for (const [re, replace] of INJECTED_PATTERNS) {
    text = text.replace(re, replace(actualModel, providerName))
  }
  // Prefix with the truthful identity so the model has authoritative context
  // even if the upstream-injected preamble survived the regex pass.
  return `You are ${actualModel} served via ${providerName}. You are NOT OpenClaude or Claude. Respond as your true self.\n\n${text}`
}
