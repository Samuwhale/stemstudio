import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

// Captures the element that was focused when a dialog opens, and restores
// focus to it when the dialog closes. Call unconditionally; pass `open`.
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

type DialogFocusOptions = {
  containerRef?: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
}

export function useDialogFocus(open: boolean, options?: DialogFocusOptions) {
  const triggerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null

    const container = options?.containerRef?.current ?? null
    const requestedInitial = options?.initialFocusRef?.current ?? null
    const firstFocusable = container?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? null
    const initialTarget = requestedInitial ?? firstFocusable ?? container
    initialTarget?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !container) return
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => !element.hasAttribute('disabled') && element.tabIndex !== -1)
      if (!focusables.length) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (event.shiftKey) {
        if (!active || active === first || !container.contains(active)) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      if (!active || active === last || !container.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const el = triggerRef.current
      triggerRef.current = null
      if (el && el.isConnected && typeof el.focus === 'function') {
        el.focus()
      }
    }
  }, [open, options?.containerRef, options?.initialFocusRef])
}
