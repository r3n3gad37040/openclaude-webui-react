import { useRef, useCallback } from 'react'

export function useAutoResize(minHeight = 44, maxHeight = 400) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    if (!ref.current) return
    ref.current.style.height = 'auto'
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, maxHeight)}px`
  }, [maxHeight])

  return { ref, resize }
}

export function useModelCapabilities(
  modelId: string,
  models: Array<{ id: string }>,
) {
  const modelEntry = models.find((m) => m.id === modelId)
  // Infer capabilities from model ID patterns
  const lower = modelId.toLowerCase()
  return {
    isImage: /flux|imagen|\bimage\b|imagine|stable[._-]diff|sdxl|hidream|aura|dall[._-]e|playground[._-]v|wai[._-]nsfw/i.test(lower),
    isVideo: /video|mochi|wan[._-]|kling|cogvideo|animate|minimax[._-]vid/i.test(lower),
    hasResolution: lower.includes('flux') || lower.includes('sdxl') || lower.includes('dall'),
    hasAspectRatio: true,
    hasDuration: /video|mochi|wan|kling|cogvideo/i.test(lower),
  }
}
