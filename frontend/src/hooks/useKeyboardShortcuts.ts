import { useEffect, useEffectEvent } from 'react'

type Shortcuts = {
  onNavigatePrev?: () => void
  onNavigateNext?: () => void
  onRerun?: () => void
  onAddSongs?: () => void
  onToggleSettings?: () => void
  onToggleShortcuts?: () => void
  onEscape?: () => void
  onSelectRunByIndex?: (index: number) => void
}

function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true
  return target.isContentEditable
}

export function useKeyboardShortcuts(shortcuts: Shortcuts) {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      shortcuts.onEscape?.()
      return
    }

    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault()
      shortcuts.onToggleSettings?.()
      return
    }

    if (isEditable(event.target)) return
    if (event.metaKey || event.ctrlKey || event.altKey) return

    if (event.key === '?') {
      event.preventDefault()
      shortcuts.onToggleShortcuts?.()
      return
    }

    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      shortcuts.onNavigateNext?.()
      return
    }

    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      shortcuts.onNavigatePrev?.()
      return
    }

    if (event.key === 'r') {
      event.preventDefault()
      shortcuts.onRerun?.()
      return
    }

    if (event.key === 'a') {
      event.preventDefault()
      shortcuts.onAddSongs?.()
      return
    }

    if (/^[1-9]$/.test(event.key)) {
      const index = Number.parseInt(event.key, 10) - 1
      shortcuts.onSelectRunByIndex?.(index)
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
