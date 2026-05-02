import type {
  BatchDeleteResponse,
  BatchTrackIdsInput,
  ConfirmImportDraftsInput,
  ConfirmImportDraftsResponse,
  Diagnostics,
  ExportBundleCleanupResponse,
  ExportBundleInput,
  ExportBundleResponse,
  ExportPlanInput,
  ExportPlanResponse,
  ExportStemsInput,
  ExportStemsResponse,
  ImportDraft,
  LibraryResetResponse,
  NonKeeperCleanupResponse,
  RevealFolderInput,
  RevealFolderResponse,
  ActiveRunsResponse,
  ResolveLocalImportResponse,
  ResolveYouTubeImportResponse,
  RunDetail,
  RunMixStemEntry,
  RunMutationResponse,
  RunProcessingConfigInput,
  Settings,
  StorageOverview,
  TempCleanupResponse,
  TrackDetail,
  TrackSummary,
  UpdateImportDraftInput,
} from './types'
import { discardRejection } from './async'

function hasJsonBody(response: Response) {
  const contentType = response.headers.get('content-type') ?? ''
  return contentType.includes('application/json')
}

async function parseErrorBody(response: Response): Promise<string | null> {
  if (hasJsonBody(response)) {
    try {
      const payload = (await response.json()) as { detail?: unknown } | null
      if (payload) {
        const detail = payload.detail
        if (typeof detail === 'string' && detail.trim()) {
          return detail
        }
        if (Array.isArray(detail)) {
          const messages = detail
            .map((item) => {
              if (!item || typeof item !== 'object') return null
              const entry = item as { loc?: unknown; msg?: unknown }
              const message = typeof entry.msg === 'string' ? entry.msg.trim() : ''
              if (!message) return null
              const location = Array.isArray(entry.loc)
                ? entry.loc
                    .filter((part) => typeof part === 'string' || typeof part === 'number')
                    .slice(1)
                    .join('.')
                : ''
              return location ? `${location}: ${message}` : message
            })
            .filter((message): message is string => !!message)
          if (messages.length) {
            return messages.slice(0, 3).join(' · ')
          }
        }
      }
    } catch {
      return null
    }
    return null
  }
  try {
    const text = (await response.text()).trim()
    if (!text) return null
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return null
  }
}

async function parseSuccessBody<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.status === 205) {
    return undefined as T
  }

  const contentLength = response.headers.get('content-length')
  if (contentLength === '0') {
    return undefined as T
  }

  if (hasJsonBody(response)) {
    const raw = await response.text()
    if (!raw.trim()) {
      return undefined as T
    }
    return JSON.parse(raw) as T
  }

  const text = await response.text()
  return (text || undefined) as T
}

class ApiError extends Error {
  status: number
  statusText: string
  detail: string | null

  constructor(response: Response, detail: string | null) {
    const status = `${response.status} ${response.statusText}`.trim()
    super(detail ? `${status} — ${detail}` : `Request failed (${status}).`)
    this.name = 'ApiError'
    this.status = response.status
    this.statusText = response.statusText
    this.detail = detail
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

async function fetchApi<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch (error) {
    const cause = error instanceof Error ? error.message : 'Network request failed.'
    throw new Error(`Network error: ${cause}`)
  }

  if (!response.ok) {
    const detail = await parseErrorBody(response)
    throw new ApiError(response, detail)
  }

  return parseSuccessBody<T>(response)
}

function postApi<T>(url: string, body: unknown): Promise<T> {
  return fetchApi<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function patchApi<T>(url: string, body: unknown): Promise<T> {
  return fetchApi<T>(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function putApi<T>(url: string, body: unknown): Promise<T> {
  return fetchApi<T>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function postKeepalive(url: string, body?: unknown) {
  const init: RequestInit = {
    method: 'POST',
    keepalive: true,
  }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  discardRejection(fetch(url, init))
}

export function getDiagnostics() {
  return fetchApi<Diagnostics>('/api/diagnostics')
}

export function getSettings() {
  return fetchApi<Settings>('/api/settings')
}

export function updateSettings(settings: Omit<Settings, 'stem_options' | 'quality_options'>) {
  return putApi<Settings>('/api/settings', settings)
}

export function getStorageOverview() {
  return fetchApi<StorageOverview>('/api/storage')
}

export function cleanupTempStorage() {
  return fetchApi<TempCleanupResponse>('/api/storage/cleanup/temp', {
    method: 'POST',
  })
}

export function cleanupExportBundles() {
  return fetchApi<ExportBundleCleanupResponse>('/api/storage/cleanup/export-bundles', {
    method: 'POST',
  })
}

export function cleanupNonKeeperRunsLibrary() {
  return fetchApi<NonKeeperCleanupResponse>('/api/storage/cleanup/non-keeper-runs', {
    method: 'POST',
  })
}

export function flushPendingLibraryCleanup() {
  postKeepalive('/api/storage/cleanup/non-keeper-runs')
}

export function resetLibrary() {
  return fetchApi<LibraryResetResponse>('/api/storage/reset', {
    method: 'POST',
  })
}

// --- Tracks ---

export function getTracks() {
  return fetchApi<TrackSummary[]>('/api/tracks')
}

export function getTrack(trackId: string) {
  return fetchApi<TrackDetail>(`/api/tracks/${trackId}`)
}

export function updateTrack(trackId: string, payload: { title?: string; artist?: string | null }) {
  return putApi<TrackDetail>(`/api/tracks/${trackId}`, payload)
}

// --- Runs ---

export function createRun(trackId: string, processing: RunProcessingConfigInput) {
  return postApi<RunMutationResponse>(`/api/tracks/${trackId}/runs`, { processing })
}

export function cancelRun(runId: string) {
  return fetchApi<RunMutationResponse>(`/api/runs/${runId}/cancel`, { method: 'POST' })
}

export function retryRun(runId: string) {
  return fetchApi<RunMutationResponse>(`/api/runs/${runId}/retry`, { method: 'POST' })
}

export function dismissRun(runId: string) {
  return fetchApi<RunMutationResponse>(`/api/runs/${runId}/dismiss`, { method: 'POST' })
}

export async function deleteRun(runId: string) {
  await fetchApi(`/api/runs/${runId}`, { method: 'DELETE' })
}

export function updateRunMix(trackId: string, runId: string, stems: RunMixStemEntry[]) {
  return putApi<RunDetail>(`/api/tracks/${trackId}/runs/${runId}/mix`, { stems })
}

export function getActiveRuns() {
  return fetchApi<ActiveRunsResponse>('/api/runs/active')
}

// --- Keeper / cleanup ---

export function setKeeperRun(trackId: string, runId: string | null) {
  return putApi<TrackDetail>(`/api/tracks/${trackId}/keeper`, { run_id: runId })
}

export function batchDeleteTracks(payload: BatchTrackIdsInput) {
  return postApi<BatchDeleteResponse>('/api/tracks/batch/delete', payload)
}

export function flushPendingTrackDeletes(trackIds: string[]) {
  if (!trackIds.length) return
  postKeepalive('/api/tracks/batch/delete', { track_ids: trackIds })
}

// --- Imports (drafts) ---

export function resolveYouTubeImport(sourceUrl: string) {
  return postApi<ResolveYouTubeImportResponse>('/api/imports/youtube/resolve', {
    source_url: sourceUrl,
  })
}

export function resolveLocalImport(files: File[]) {
  const formData = new FormData()
  for (const file of files) formData.append('files', file)
  return fetchApi<ResolveLocalImportResponse>('/api/imports/local/resolve', {
    method: 'POST',
    body: formData,
  })
}

export function listImportDrafts() {
  return fetchApi<ImportDraft[]>('/api/imports/drafts')
}

export function updateImportDraft(draftId: string, payload: UpdateImportDraftInput) {
  return patchApi<ImportDraft>(`/api/imports/drafts/${draftId}`, payload)
}

export async function discardImportDraft(draftId: string) {
  await fetchApi(`/api/imports/drafts/${draftId}`, { method: 'DELETE' })
}

export function confirmImportDrafts(payload: ConfirmImportDraftsInput) {
  return postApi<ConfirmImportDraftsResponse>('/api/imports/drafts/confirm', payload)
}

// --- Exports ---

export function createExportBundle(payload: ExportBundleInput) {
  return postApi<ExportBundleResponse>('/api/exports/bundle', payload)
}

export function planExportBundle(payload: ExportPlanInput) {
  return postApi<ExportPlanResponse>('/api/exports/plan', payload)
}

export function listExportStems(payload: ExportStemsInput) {
  return postApi<ExportStemsResponse>('/api/exports/stems', payload)
}

// --- System ---

export function revealFolder(payload: RevealFolderInput) {
  return postApi<RevealFolderResponse>('/api/system/reveal', payload)
}

// --- Admin ---

export function backfillMetrics() {
  return fetchApi<{ updated_artifact_count: number }>('/api/admin/backfill-metrics', {
    method: 'POST',
  })
}
