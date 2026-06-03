import { useEffect } from 'react'

export type ToastTone = 'success' | 'error' | 'info'

export type ToastAction = {
  label: string
  onInvoke: () => void
}

export type Toast = {
  id: string
  tone: ToastTone
  message: string
  createdAt: number
  autoDismissMs: number | null
  action?: ToastAction
}

type ToastStackProps = {
  toasts: Toast[]
  onDismiss: (id: string) => void
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (!toasts.length) return null

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (!toast.autoDismissMs) return
    const timeoutId = window.setTimeout(() => onDismiss(toast.id), toast.autoDismissMs)
    return () => window.clearTimeout(timeoutId)
  }, [toast.id, toast.autoDismissMs, onDismiss])

  return (
    <div className={`toast toast-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
      <span className={`toast-dot toast-dot-${toast.tone}`} />
      <span className="toast-body">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.onInvoke()
            onDismiss(toast.id)
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  )
}
