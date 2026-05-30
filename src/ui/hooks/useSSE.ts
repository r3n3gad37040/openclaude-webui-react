import { useRef, useCallback } from 'react'
import type { Model } from '../../types/index.js'

export interface SSECallbacks {
  onChunk: (content: string) => void
  onToolStart: (name: string, tool_id: string) => void
  onToolDone: (name: string, tool_id: string, input: string) => void
  onUsage: (input_tokens: number, output_tokens: number) => void
  onMedia: (url: string, media_type: 'image' | 'video', alt?: string, width?: number, height?: number) => void
  onDone: () => void
  onError: (error: string) => void
}

export function useSSE() {
  const abortRef = useRef<AbortController | null>(null)

  const connect = useCallback((sessionId: string, modelId: string, message: string, callbacks: SSECallbacks, signal?: AbortSignal) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    fetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text()
        callbacks.onError(`Server error: ${res.status} ${text}`)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) return

      const decoder = new TextDecoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done || controller.signal.aborted) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6)
            if (!raw || raw === '[DONE]') continue

            try {
              const event = JSON.parse(raw) as Record<string, unknown>
              switch (event['type']) {
                case 'chunk':
                  callbacks.onChunk(event['content'] as string)
                  break
                case 'tool_start':
                  callbacks.onToolStart(event['name'] as string, event['tool_id'] as string)
                  break
                case 'tool_done':
                  callbacks.onToolDone(event['name'] as string, event['tool_id'] as string, event['input'] as string)
                  break
                case 'usage':
                  const d = event['data'] as { input_tokens: number; output_tokens: number }
                  callbacks.onUsage(d.input_tokens, d.output_tokens)
                  break
                case 'media':
                  callbacks.onMedia(
                    event['url'] as string,
                    event['media_type'] as 'image' | 'video',
                    event['alt'] as string | undefined,
                    event['width'] as number | undefined,
                    event['height'] as number | undefined,
                  )
                  break
                case 'error':
                  callbacks.onError(event['content'] as string)
                  break
                case 'done':
                  callbacks.onDone()
                  return
              }
            } catch {
              // Skip malformed SSE events (keepalives, comments)
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          callbacks.onError(err instanceof Error ? err.message : 'Stream error')
        }
      }
    }).catch((err) => {
      if (!controller.signal.aborted) {
        callbacks.onError(err instanceof Error ? err.message : 'Connection failed')
      }
    })

    return controller
  }, [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  return { connect, cancel }
}
