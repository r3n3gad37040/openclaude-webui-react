import React from 'react'
import { useStreamStore } from '../stores/streaming.js'
import { useAppStore } from '../stores/app.js'

/* ─── Cost estimation (matches backend) ─────────────────────────── */
const COST_MAP: Array<[string, number, number]> = [
  ['kimi-k2', 2.0, 8.0],
  ['grok-3', 3.0, 15.0],
  ['grok-4', 5.0, 20.0],
  ['llama-4-maverick', 0.2, 0.8],
  ['gemma', 0.4, 1.6],
  ['deepseek', 0.5, 2.0],
  ['claude', 3.0, 15.0],
]

function getModelCost(modelId: string) {
  const lower = modelId.toLowerCase()
  for (const [key, inp, out] of COST_MAP) {
    if (lower.includes(key)) return { input_per_m: inp, output_per_m: out }
  }
  return { input_per_m: 1.0, output_per_m: 4.0 }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/* ─── Telemetry Bar ─────────────────────────────────────────────── */
export const TelemetryBar: React.FC = () => {
  const { currentModelId, models } = useAppStore()
  const { isStreaming, session } = useStreamStore()

  if (!currentModelId && !session) return null

  // Model info
  const modelEntry = models?.find((m) => m.id === currentModelId)
  const contextWindow = modelEntry?.context_window ?? 128_000
  const costs = getModelCost(currentModelId)

  // Session tokens
  const sessionTokens = session ?? { inputTokens: 0, outputTokens: 0, estimatedCost: 0, running: { status: 'idle' } }
  const inputTok = sessionTokens.inputTokens ?? 0
  const outputTok = sessionTokens.outputTokens ?? 0
  const totalTok = inputTok + outputTok

  // Running cost for this request
  const runningCost = totalTok > 0
    ? parseFloat(((inputTok * costs.input_per_m) / 1_000_000 + (outputTok * costs.output_per_m) / 1_000_000).toFixed(4))
    : null

  // Context usage percentage (based on accumulated input tokens)
  const contextPct = contextWindow > 0 ? Math.min((totalTok / contextWindow) * 100, 100) : 0
  const contextColor = contextPct > 80 ? '#ef4444' : contextPct > 50 ? '#f59e0b' : '#22c55e'

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '1.5rem',
      padding: '0.375rem 1rem',
      fontSize: '10px',
      color: 'var(--color-muted)',
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      borderBottom: '1px solid var(--color-border)',
      backgroundColor: 'var(--color-surface)',
    }}>
      {/* Context window */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
        <span>Context</span>
        <div style={{
          width: '80px',
          height: '6px',
          backgroundColor: 'var(--color-border)',
          borderRadius: '3px',
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${contextPct}%`,
            height: '100%',
            backgroundColor: contextColor,
            borderRadius: '3px',
            transition: 'width 0.3s ease, background-color 0.3s ease',
          }} />
        </div>
        <span>{formatTok(totalTok)} / {formatTok(contextWindow)}</span>
      </div>

      {/* Input tokens */}
      {inputTok > 0 && (
        <span>↑ {formatTok(inputTok)} in</span>
      )}

      {/* Output tokens */}
      {outputTok > 0 && (
        <span>↓ {formatTok(outputTok)} out</span>
      )}

      {/* Running cost */}
      {runningCost !== null && runningCost > 0 && isStreaming && (
        <span style={{ color: '#22c555' }}>
          ${runningCost.toFixed(4)} (live)
        </span>
      )}

      {/* Model cost rates */}
      <span style={{ opacity: 0.5 }}>
        ${costs.input_per_m.toFixed(2)}/${costs.output_per_m.toFixed(2)} per 1M
      </span>

      {/* Status indicator */}
      {isStreaming && (
        <span style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.25rem',
          color: '#22c555',
        }}>
          <span className="animate-pulse-dot" style={{
            display: 'inline-block',
            width: '6px',
            height: '6px',
            borderRadius: '9999px',
            backgroundColor: '#22c555',
          }} />
          Streaming
        </span>
      )}
    </div>
  )
}

function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}
