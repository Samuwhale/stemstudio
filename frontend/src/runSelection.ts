import type { RunDetail } from './types'

type RunOwner = {
  runs: RunDetail[]
  keeper_run_id?: string | null
}

type VisibleRun = Pick<RunDetail, 'dismissed_at' | 'id' | 'status'>

export function isDismissedTerminalRun(run: VisibleRun) {
  return (
    run.dismissed_at !== null &&
    (run.status === 'failed' || run.status === 'cancelled')
  )
}

export function isVisibleRun(run: VisibleRun) {
  return !isDismissedTerminalRun(run)
}

export function listVisibleRuns<R extends VisibleRun>(runs: readonly R[]): R[] {
  return runs.filter(isVisibleRun)
}

export function resolveVisibleRunAtIndex(track: RunOwner, index: number): RunDetail | null {
  if (index < 0) return null
  return listVisibleRuns(track.runs)[index] ?? null
}

function resolveDefaultRun(track: RunOwner): RunDetail | null {
  if (track.keeper_run_id) {
    const keeperRun = track.runs.find((run) => run.id === track.keeper_run_id)
    if (keeperRun) return keeperRun
  }

  return listVisibleRuns(track.runs)[0] ?? null
}

export function resolveSelectedRun(track: RunOwner, selectedRunId: string | null): RunDetail | null {
  const visibleRuns = listVisibleRuns(track.runs)
  if (!visibleRuns.length) return null
  if (selectedRunId) {
    const matchingRun = visibleRuns.find((run) => run.id === selectedRunId)
    if (matchingRun) return matchingRun
  }
  return resolveDefaultRun(track)
}
