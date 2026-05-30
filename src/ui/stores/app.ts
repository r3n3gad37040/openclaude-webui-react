import { create } from 'zustand'
import type { Provider, Model, AppStatus, Theme } from '../../types/index.js'
import * as api from '../utils/api.js'

interface AppState {
  providers: Provider[]
  models: Model[]
  currentProvider: string
  currentModel: string
  currentModelId: string
  sessions: Array<{ id: string; title: string; model_id: string; created_at: string; updated_at: string; message_count: number }>
  activeSessionId: string | null
  status: AppStatus | null
  themes: Array<{ id: string; name: string }>
  theme: Theme
  initialized: boolean
  loading: boolean

  // Actions
  fetchProviders: () => Promise<void>
  fetchModels: () => Promise<void>
  fetchSessions: () => Promise<void>
  createSession: () => Promise<string>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  selectSession: (id: string) => void
  setStatus: (s: AppStatus | null) => void
  fetchStatus: () => Promise<void>
  startStatusPoll: () => void
  stopStatusPoll: () => void
  setTheme: (theme: Theme) => void
  fetchThemes: () => Promise<void>
  init: () => Promise<void>
}

let _pollInterval: ReturnType<typeof setInterval> | null = null

export const useAppStore = create<AppState>((set, get) => ({
  providers: [],
  models: [],
  currentProvider: '',
  currentModel: '',
  currentModelId: '',
  sessions: [],
  activeSessionId: null,
  status: null,
  themes: [],
  theme: 'dark',
  initialized: false,
  loading: false,

  fetchProviders: async () => {
    try {
      const { providers } = await api.getProviders()
      set({ providers })
    } catch { /* silent */ }
  },

  fetchModels: async () => {
    try {
      const { models, current, current_provider } = await api.getModels()
      set({ models, currentModelId: current, currentProvider: current_provider, currentModel: current ? current.split('/')[1] || '' : '' })
    } catch { /* silent */ }
  },

  fetchSessions: async () => {
    try {
      const sessions = await api.listSessions()
      set({ sessions })
    } catch { /* silent */ }
  },

  createSession: async () => {
    const { id } = await api.createSession()
    await get().fetchSessions()
    get().selectSession(id)
    return id
  },

  deleteSession: async (id: string) => {
    await api.deleteSession(id)
    await get().fetchSessions()
    if (get().activeSessionId === id) {
      const sessions = get().sessions
      get().selectSession(sessions.length > 0 ? sessions[0].id : null)
    }
  },

  renameSession: async (id: string, title: string) => {
    await api.renameSession(id, title)
    await get().fetchSessions()
  },

  selectSession: (id: string | null) => {
    set({ activeSessionId: id })
  },

  setStatus: (s: AppStatus | null) => {
    set({ status: s })
  },

  fetchStatus: async () => {
    try {
      const status = await api.getStatus()
      set({ status })
    } catch { /* silent */ }
  },

  startStatusPoll: () => {
    if (_pollInterval) return
    void get().fetchStatus()
    _pollInterval = setInterval(() => void get().fetchStatus(), 10000)
  },

  stopStatusPoll: () => {
    if (_pollInterval) {
      clearInterval(_pollInterval)
      _pollInterval = null
    }
  },

  setTheme: (theme: Theme) => {
    set({ theme })
    document.documentElement.className = theme
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('openclaude-theme', theme)
    } catch {}
  },

  fetchThemes: async () => {
    try {
      const { themes } = await api.getThemes()
      set({ themes })
    } catch { /* silent */ }
  },

  init: async () => {
    set({ loading: true })
    await Promise.all([
      get().fetchProviders(),
      get().fetchModels(),
      get().fetchSessions(),
      get().fetchThemes(),
    ])

    // Restore theme
    const savedTheme = (() => {
      try { return localStorage.getItem('openclaude-theme') ?? 'dark' } catch { return 'dark' }
    })()
    get().setTheme(savedTheme as Theme)

    const sessions = get().sessions
    set({
      activeSessionId: sessions.length > 0 ? sessions[0].id : null,
      loading: false,
      initialized: true,
    })
    get().startStatusPoll()
  },
}))
