import { useEffect, useState } from 'react'

import { discardRejection } from '../../async'

type ConfirmInlineProps = {
  label: string
  pendingLabel: string
  confirmLabel: string
  cancelLabel?: string
  prompt: string
  disabled?: boolean
  pending?: boolean
  onConfirm: () => void | Promise<void>
}

export function ConfirmInline({
  label,
  pendingLabel,
  confirmLabel,
  cancelLabel = 'Keep',
  prompt,
  disabled,
  pending,
  onConfirm,
}: ConfirmInlineProps) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timeoutId = window.setTimeout(() => setArmed(false), 5000)
    return () => window.clearTimeout(timeoutId)
  }, [armed])

  if (pending) {
    return (
      <button type="button" className="button-secondary" disabled>
        {pendingLabel}
      </button>
    )
  }

  if (!armed) {
    return (
      <button
        type="button"
        className="button-secondary"
        disabled={disabled}
        onClick={() => setArmed(true)}
      >
        {label}
      </button>
    )
  }

  return (
    <span className="confirm-inline" role="group" aria-label={prompt}>
      <span className="confirm-inline-prompt">{prompt}</span>
      <button
        type="button"
        className="button-secondary confirm-inline-confirm"
        disabled={disabled || pending}
        onClick={() => {
          setArmed(false)
          discardRejection(onConfirm)
        }}
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        className="button-secondary"
        onClick={() => setArmed(false)}
      >
        {cancelLabel}
      </button>
    </span>
  )
}
