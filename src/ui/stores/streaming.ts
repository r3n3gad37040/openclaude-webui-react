import { create } from 'zustand'
import type { Model } from '../../types/index.js'

export type RunningState =
  | { status: 'idle' }
  | { status: 'thinking' }
  | { status: 'streaming'; content: string }
  | { status: 'tool_running'; toolName: string; content: string }
  | { status: 'done'; content: string }
  | { status: 'error'; error: string }

export interface StreamingSession {
  sessionId: string
  running: RunningState
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  cancelController: AbortController | null
}

interface StreamState {
  session: StreamingSession | null
  isStreaming: boolean
  modelType: 'text' | 'image' | 'video' | 'audio'

  // Media parameter state
  mediaParams: {
    resolution: string
    aspectRatio: string
    videoDuration: string
  }

  // Actions
  startStreaming: (sessionId: string, modelType: 'text' | 'image' | 'video' | 'audio') => void
  handleChunk: (content: string) => void
  handleToolStart: (name: string) => void
  handleToolDone: () => void
  handleUsage: (input_tokens: number, output_tokens: number) => void
  handleMedia: (url: string, media_type: 'image' | 'video', alt?: string) => void
  handleError: (error: string) => void
  handleDone: () => void
  cancel: () => void
  reset: () => void
  setMediaParam: (key: string, value: string) => void
}

export const useStreamStore = create<StreamState>((set, get) => ({
  session: null,
  isStreaming: false,
  modelType: 'text',

  mediaParams: {
    resolution: '1024x1024',
    aspectRatio: '1:1',
    videoDuration: '5s',
  },

  startStreaming: (sessionId: string, modelType: 'text' | 'image' | 'video' | 'audio') => {
    const controller = new AbortController()
    set({
      isStreaming: true,
      modelType,
      session: {
        sessionId,
        running: modelType === 'text' ? { status: 'thinking' } : { status: 'tool_running', toolName: modelType === 'video' ? 'Generating video' : 'Generating image', content: '' },
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        cancelController: controller,
      },
    })
  },

  handleChunk: (content: string) => {
    const s = get().session
    if (!s) return
    s.running = { status: 'streaming', content: s.running.status === 'thinking' ? content : (s.running as { status: string; content: string }).content + content }
    set({ session: { ...s } })
  },

  handleToolStart: (name: string) => {
    const s = get().session
    if (!s) return
    s.running = { status: 'tool_running', toolName: name, content: (s.running as { status: string; content: string }).content ?? '' }
    set({ session: { ...s } })
  },

  handleToolDone: () => {
    const s = get().session
    if (!s) return
    set({ session: { ...s } })
  },

  handleUsage: (input_tokens: number, output_tokens: number) => {
    const s = get().session
    if (!s) return
    s.inputTokens = input_tokens
    s.outputTokens = output_tokens
    s.estimatedCost = parseFloat(((input_tokens * 3 / 1_000_000) + (output_tokens * 15 / 1_000_000)).toFixed(6))
    set({ session: { ...s } })
  },

  handleMedia: (url: string, media_type: 'image' | 'video', alt?: string) => {
    // Media is handled by the parent component via SSE
    // This is a placeholder for store consistency
  },

  handleError: (error: string) => {
    const s = get().session
    if (!s) return
    s.running = { status: 'error', error }
    set({ session: { ...s }, isStreaming: false })
  },

  handleDone: () => {
    const s = get().session
    if (!s) return
    const content = s.running.status === 'streaming' ? s.running.content : ''
    s.running = { status: 'done', content }
    set({ session: null, isStreaming: false })
  },

  cancel: () => {
    const s = get().session
    if (s?.cancelController) {
      s.cancelController.abort()
    }
    set({ session: null, isStreaming: false })
  },

  reset: () => {
    set({ session: null, isStreaming: false })
  },

  setMediaParam: (key: string, value: string) => {
    set((state) => ({
      mediaParams: { ...state.mediaParams, [key]: value },
    }))
  },
}))
