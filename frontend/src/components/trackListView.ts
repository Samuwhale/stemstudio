import type { SongsFilter } from '../routes'
import type { TrackSummary } from '../types'
import { isActiveRunStatus } from './runStatus'

export type SongBrowseSort = 'recent' | 'created' | 'title' | 'runs'

export type TrackStageSummary = {
  key: 'processing' | 'needs-attention' | 'needs-stems' | 'ready' | 'final'
  label: string
  description: string
}

export function isReadyTrackStage(stageKey: TrackStageSummary['key']) {
  return stageKey === 'ready' || stageKey === 'final'
}

export function resolveTrackExportRunId(track: TrackSummary): string | null {
  if (track.keeper_run_id) return track.keeper_run_id
  if (track.latest_run?.status === 'completed') return track.latest_run.id
  return null
}

export function isTrackExportable(track: TrackSummary) {
  return isReadyTrackStage(trackStageSummary(track).key) && resolveTrackExportRunId(track) !== null
}

export function isTrackStemmable(track: TrackSummary) {
  return trackStageSummary(track).key !== 'processing'
}

export function selectTracksByIds(tracks: TrackSummary[], selectedTrackIds: string[]): TrackSummary[] {
  if (selectedTrackIds.length === 0) return []
  const selectedIdSet = new Set(selectedTrackIds)
  return tracks.filter((track) => selectedIdSet.has(track.id))
}

export function describeTrackStemQueuePlan(track: TrackSummary): string {
  const stage = trackStageSummary(track)
  if (stage.key === 'needs-stems') return 'Will create stems'
  if (stage.key === 'needs-attention') return 'Will queue a fresh stem set'
  if (stage.key === 'ready' || stage.key === 'final') return 'Will create another stem set'
  return 'Already creating stems'
}

export type BatchStemPlanRow = {
  track: TrackSummary
  eligible: boolean
  reason: string
}

export function planBatchStemSelection(
  tracks: TrackSummary[],
  selectedTrackIds: string[],
): BatchStemPlanRow[] {
  return selectTracksByIds(tracks, selectedTrackIds).map((track) => ({
    track,
    eligible: isTrackStemmable(track),
    reason: describeTrackStemQueuePlan(track),
  }))
}

export type BatchExportSelectionPlan = {
  selectedTracks: TrackSummary[]
  exportableTracks: TrackSummary[]
  skippedTracks: TrackSummary[]
  exportableIds: string[]
  runIds: Record<string, string>
}

export function planBatchExportSelection(
  tracks: TrackSummary[],
  selectedTrackIds: string[],
): BatchExportSelectionPlan {
  const selectedTracks = selectTracksByIds(tracks, selectedTrackIds)
  const exportableTracks = selectedTracks.filter(isTrackExportable)
  const exportableIdSet = new Set(exportableTracks.map((track) => track.id))
  const runIds = Object.fromEntries(
    exportableTracks
      .map((track) => [track.id, resolveTrackExportRunId(track)])
      .filter((pair): pair is [string, string] => pair[1] !== null),
  )

  return {
    selectedTracks,
    exportableTracks,
    skippedTracks: selectedTracks.filter((track) => !exportableIdSet.has(track.id)),
    exportableIds: exportableTracks.map((track) => track.id),
    runIds,
  }
}

export const SONG_BROWSE_SORT_OPTIONS: { value: SongBrowseSort; label: string; shortLabel: string }[] = [
  { value: 'recent', label: 'Recently updated', shortLabel: 'Recent' },
  { value: 'created', label: 'Recently added', shortLabel: 'Added' },
  { value: 'title', label: 'Title A–Z', shortLabel: 'A–Z' },
  { value: 'runs', label: 'Most stem sets', shortLabel: 'Sets' },
]

export function trackStageSummary(track: TrackSummary): TrackStageSummary {
  const latestStatus = track.latest_run?.status ?? null

  if (track.keeper_run_id) {
    return {
      key: 'final',
      label: track.has_custom_mix ? 'Saved mix' : 'Preferred export',
      description: track.has_custom_mix
        ? 'Your preferred stem set has saved mix changes and is ready to export.'
        : 'A preferred stem set is ready to mix or export.',
    }
  }

  if (latestStatus === 'failed' || latestStatus === 'cancelled') {
    return {
      key: 'needs-attention',
      label: 'Stem job failed',
      description: 'Retry the latest stem job or create a different stem set.',
    }
  }

  if (latestStatus && isActiveRunStatus(latestStatus)) {
    return {
      key: 'processing',
      label: 'Creating stems',
      description: track.latest_run?.status_message || 'Stems are still being created.',
    }
  }

  if (latestStatus === 'completed') {
    return {
      key: 'ready',
      label: track.has_custom_mix ? 'Saved mix' : 'Ready to mix',
      description: track.has_custom_mix
        ? 'A saved stem balance is ready to reopen or export.'
        : 'The latest stem set is ready to adjust and export.',
    }
  }

  return {
    key: 'needs-stems',
    label: 'No stems',
    description: 'Create stems before this song can be mixed or exported.',
  }
}

export function applySongBrowse(
  tracks: TrackSummary[],
  view: {
    search: string
    sort: SongBrowseSort
    filter?: SongsFilter
  },
) {
  const query = view.search.trim().toLowerCase()
  const filter = view.filter ?? 'all'

  const matches = tracks.filter((track) => {
    if (query) {
      const haystack = `${track.title} ${track.artist ?? ''}`.toLowerCase()
      if (!haystack.includes(query)) return false
    }
    if (filter !== 'all') {
      const stage = trackStageSummary(track)
      if (filter === 'needs-stems') return stage.key === 'needs-stems'
      if (filter === 'processing') return stage.key === 'processing'
      if (filter === 'attention') return stage.key === 'needs-attention'
      if (filter === 'ready') return isReadyTrackStage(stage.key)
    }
    return true
  })

  return [...matches].sort((a, b) => {
    switch (view.sort) {
      case 'title':
        return a.title.localeCompare(b.title)
      case 'runs':
        return b.run_count - a.run_count
      case 'created':
        return b.created_at.localeCompare(a.created_at)
      default:
        return b.updated_at.localeCompare(a.updated_at)
    }
  })
}
