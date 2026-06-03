import type { SongBrowseSort } from './components/trackListView'

export type SongsFilter = 'all' | 'needs-stems' | 'processing' | 'attention' | 'ready'

export type SongsView = {
  search: string
  sort: SongBrowseSort
  filter: SongsFilter
}

const SONG_SORTS = new Set<SongBrowseSort>(['recent', 'created', 'title', 'runs'])
const SONG_FILTERS = new Set<SongsFilter>(['all', 'needs-stems', 'processing', 'attention', 'ready'])

export function parseSongsView(searchParams: URLSearchParams): SongsView {
  const sort = searchParams.get('sort')
  const search = searchParams.get('search')?.trim() ?? ''
  const filter = searchParams.get('filter')

  return {
    sort: sort && SONG_SORTS.has(sort as SongBrowseSort) ? (sort as SongBrowseSort) : 'recent',
    search,
    filter: filter && SONG_FILTERS.has(filter as SongsFilter) ? (filter as SongsFilter) : 'all',
  }
}

export function buildSongsPath(view: SongsView) {
  const searchParams = new URLSearchParams()

  if (view.sort !== 'recent') searchParams.set('sort', view.sort)
  if (view.search.trim()) searchParams.set('search', view.search.trim())
  if (view.filter && view.filter !== 'all') searchParams.set('filter', view.filter)

  const search = searchParams.toString()
  return search ? `/songs?${search}` : '/songs'
}

export function buildMixPath(trackId: string, options?: { runId?: string | null }) {
  const searchParams = new URLSearchParams()

  if (options?.runId) searchParams.set('run', options.runId)

  const search = searchParams.toString()
  return search ? `/mix/${trackId}?${search}` : `/mix/${trackId}`
}
