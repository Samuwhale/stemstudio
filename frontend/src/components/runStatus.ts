import type { RunSummary } from '../types'

const ACTIVE_RUN_STATUSES = new Set(['queued', 'preparing', 'separating', 'exporting'])

export type RunJourneyStatus = {
  label: string
  detail: string
  tone: 'active' | 'ready' | 'attention'
  progressLabel: string | null
}

export function isActiveRunStatus(status: string): boolean {
  return ACTIVE_RUN_STATUSES.has(status)
}

// Detailed labels used where the user benefits from knowing the exact pipeline
// stage. Kept fine-grained so a 90-second job still feels alive.
export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  preparing: 'Preparing audio',
  separating: 'Separating stems',
  exporting: 'Writing stem files',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

// Short labels for compact surfaces (run chips, inline summaries).
export const RUN_STATUS_SHORT_LABELS: Record<string, string> = {
  queued: 'Queued',
  preparing: 'Processing',
  separating: 'Processing',
  exporting: 'Processing',
  completed: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const RUN_STAGE_DESCRIPTIONS: Record<string, string> = {
  queued: 'waiting for a worker',
  preparing: 'decoding + normalising',
  separating: 'creating stems',
  exporting: 'saving separated files',
}

export function describeRun(run: RunSummary): string {
  const message = run.status_message?.trim()
  if (message) return message
  return RUN_STAGE_DESCRIPTIONS[run.status] ?? ''
}

export function summarizeRunJourney(run: RunSummary): RunJourneyStatus {
  if (isActiveRunStatus(run.status)) {
    const progress =
      run.status !== 'queued' && run.progress > 0
        ? `${Math.round(Math.max(0, Math.min(1, run.progress)) * 100)}%`
        : null
    return {
      label: run.status === 'queued' ? 'Waiting in queue' : 'Creating stems',
      detail: describeRun(run) || RUN_STATUS_LABELS[run.status] || 'Processing',
      tone: 'active',
      progressLabel: progress,
    }
  }

  if (run.status === 'failed' || run.status === 'cancelled') {
    return {
      label: run.status === 'cancelled' ? 'Cancelled' : 'Stem set failed',
      detail: run.error_message?.trim() || run.status_message?.trim() || 'Retry this stem set or create a different one.',
      tone: 'attention',
      progressLabel: null,
    }
  }

  return {
    label: 'Ready to mix',
    detail: run.processing.label,
    tone: 'ready',
    progressLabel: null,
  }
}
