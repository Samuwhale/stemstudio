import { useMemo } from 'react'

import { isActiveRunStatus } from '../components/runStatus'
import {
  applySongBrowse,
  isTrackExportable,
  isTrackStemmable,
  trackStageSummary,
} from '../components/trackListView'
import type { SongsFilter, SongsView } from '../routes'
import type { QueueRunEntry, TrackSummary } from '../types'

type FilterTab = { value: SongsFilter; label: string; count: number }

type LibraryQuery = {
  browseTracks: TrackSummary[]
  browseTrackIds: Set<string>
  activeRuns: QueueRunEntry[]
  failedRuns: QueueRunEntry[]
  filterTabs: FilterTab[]
  stemmableIds: Set<string>
  exportableIds: Set<string>
}

export function useLibraryQuery(
  tracks: TrackSummary[],
  view: SongsView,
  queueRuns: QueueRunEntry[],
): LibraryQuery {
  const browseTracks = useMemo(
    () => applySongBrowse(tracks, { search: view.search, sort: view.sort, filter: view.filter }),
    [tracks, view.search, view.sort, view.filter],
  )

  const browseTrackIds = useMemo(
    () => new Set(browseTracks.map((track) => track.id)),
    [browseTracks],
  )

  const activeRuns = useMemo(
    () => queueRuns.filter((entry) => isActiveRunStatus(entry.run.status)),
    [queueRuns],
  )

  const failedRuns = useMemo(
    () => queueRuns.filter((entry) => entry.run.status === 'failed' || entry.run.status === 'cancelled'),
    [queueRuns],
  )

  const filterCounts = useMemo(() => {
    const counts = { 'needs-stems': 0, processing: 0, attention: 0, ready: 0 }
    for (const track of tracks) {
      const stage = trackStageSummary(track)
      if (stage.key === 'needs-stems') counts['needs-stems']++
      else if (stage.key === 'processing') counts.processing++
      else if (stage.key === 'needs-attention') counts.attention++
      else if (isTrackExportable(track)) counts.ready++
    }
    return counts
  }, [tracks])

  const filterTabs = useMemo<FilterTab[]>(() => {
    const tabs: FilterTab[] = [{ value: 'all', label: 'All', count: tracks.length }]
    if (filterCounts.processing > 0)
      tabs.push({ value: 'processing', label: 'Creating', count: filterCounts.processing })
    if (filterCounts['needs-stems'] > 0)
      tabs.push({ value: 'needs-stems', label: 'Needs stems', count: filterCounts['needs-stems'] })
    if (filterCounts.attention > 0)
      tabs.push({ value: 'attention', label: 'Issues', count: filterCounts.attention })
    if (filterCounts.ready > 0)
      tabs.push({ value: 'ready', label: 'Ready', count: filterCounts.ready })
    return tabs
  }, [tracks.length, filterCounts])

  const { exportableIds, stemmableIds } = useMemo(() => {
    const exportable = new Set<string>()
    const stemmable = new Set<string>()
    for (const track of browseTracks) {
      if (isTrackExportable(track)) exportable.add(track.id)
      if (isTrackStemmable(track)) stemmable.add(track.id)
    }
    return { exportableIds: exportable, stemmableIds: stemmable }
  }, [browseTracks])

  return {
    browseTracks,
    browseTrackIds,
    activeRuns,
    failedRuns,
    filterTabs,
    stemmableIds,
    exportableIds,
  }
}
