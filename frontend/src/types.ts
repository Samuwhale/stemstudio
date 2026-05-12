export type StemOption = {
  name: string
  label: string
}

export type QualityOption = {
  key: StemQuality
  label: string
}

type RunProcessingConfig = {
  stems: string[]
  quality: StemQuality
  label: string
}

export type RunProcessingConfigInput = {
  stems: string[]
  quality: StemQuality
}

export type StemQuality = 'fast' | 'balanced'

export type Settings = {
  storage: {
    database_path: string
    uploads_directory: string
    outputs_directory: string
    exports_directory: string
    temp_directory: string
    model_cache_directory: string
  }
  retention: {
    temp_max_age_hours: number
    export_bundle_max_age_days: number
  }
  default_stem_selection: RunProcessingConfig
  export_mp3_bitrate: string
  stem_options: StemOption[]
  quality_options: QualityOption[]
}

type StorageBucketKey =
  | 'database'
  | 'uploads'
  | 'outputs'
  | 'export_bundles'
  | 'temp'
  | 'model_cache'

export type StorageBucket = {
  key: StorageBucketKey
  label: string
  path: string
  total_bytes: number
  reclaimable_bytes: number
}

export type StorageOverview = {
  items: StorageBucket[]
  total_bytes: number
}

type BinaryStatus = {
  name: string
  required: boolean
  available: boolean
  path: string | null
  version: string | null
}

export type Diagnostics = {
  app_ready: boolean
  separation_ready: boolean
  acceleration: string
  free_disk_gb: number
  binaries: BinaryStatus[]
  issues: string[]
  data_directories: Record<string, string>
  url_import_ready: boolean
}

export type RunSummary = {
  id: string
  processing: RunProcessingConfig
  status: string
  progress: number
  status_message: string
  error_message: string | null
  output_directory: string | null
  created_at: string
  updated_at: string
  last_active_status: string | null
  dismissed_at: string | null
}

type ArtifactMetrics = {
  duration_seconds: number | null
  sample_rate: number | null
  channels: number | null
  size_bytes: number | null
  integrated_lufs: number | null
  true_peak_dbfs: number | null
  peaks: number[]
}

export type RunArtifact = {
  id: string
  kind: string
  label: string
  format: string
  path: string
  created_at: string
  download_url: string
  metrics: ArtifactMetrics | null
}

export type RunMixStemEntry = {
  artifact_id: string
  gain_db: number
  muted: boolean
}

type RunMixState = {
  stems: RunMixStemEntry[]
  is_default: boolean
}

export const MIX_GAIN_DB_MIN = -24
export const MIX_GAIN_DB_MAX = 12

export type RunDetail = RunSummary & {
  metadata_json: Record<string, unknown>
  artifacts: RunArtifact[]
  mix: RunMixState
}

export type RunMutationResponse = {
  run: RunSummary
}

export type TrackSummary = {
  id: string
  title: string
  artist: string | null
  source_type: string
  source_url: string | null
  thumbnail_url: string | null
  source_filename: string
  duration_seconds: number | null
  created_at: string
  updated_at: string
  latest_run: RunSummary | null
  run_count: number
  keeper_run_id: string | null
  has_custom_mix: boolean
  source_peaks: number[]
}

export type TrackDetail = {
  id: string
  title: string
  artist: string | null
  source_type: string
  source_url: string | null
  thumbnail_url: string | null
  source_filename: string
  source_format: string
  source_download_url: string
  duration_seconds: number | null
  metadata_json: Record<string, unknown>
  created_at: string
  updated_at: string
  runs: RunDetail[]
  keeper_run_id: string | null
}

export type ExistingTrackDuplicate = {
  id: string
  title: string
  artist: string | null
  source_filename: string
}

type DraftSourceType = 'youtube' | 'local'
type DraftStatus = 'pending' | 'confirmed' | 'discarded'
export type DraftDuplicateAction = 'create-new' | 'reuse-existing' | 'skip'

export type ImportDraft = {
  id: string
  source_type: DraftSourceType
  status: DraftStatus
  created_at: string
  updated_at: string

  title: string
  artist: string | null
  suggested_title: string
  suggested_artist: string | null

  video_id: string | null
  source_url: string | null
  canonical_source_url: string | null
  playlist_source_url: string | null
  thumbnail_url: string | null
  duration_seconds: number | null

  original_filename: string | null
  content_hash: string | null
  size_bytes: number | null

  duplicate_action: DraftDuplicateAction | null
  existing_track_id: string | null
  duplicate_tracks: ExistingTrackDuplicate[]
}

export type ResolveYouTubeImportResponse = {
  source_kind: string
  source_title: string
  drafts: ImportDraft[]
  stem_options: StemOption[]
  quality_options: QualityOption[]
  default_processing: RunProcessingConfig
}

export type ResolveLocalImportResponse = {
  drafts: ImportDraft[]
  stem_options: StemOption[]
  quality_options: QualityOption[]
  default_processing: RunProcessingConfig
}

export type UpdateImportDraftInput = {
  title?: string
  artist?: string | null
  duplicate_action?: DraftDuplicateAction | null
  existing_track_id?: string | null
}

export type ConfirmImportDraftsInput = {
  draft_ids: string[]
  queue: boolean
  processing?: RunProcessingConfigInput
}

export type ConfirmImportDraftsResponse = {
  tracks: TrackSummary[]
  created_track_count: number
  reused_track_count: number
  skipped_draft_count: number
  queued_run_count: number
}

export type QueueRunEntry = {
  run: RunSummary
  track_id: string
  track_title: string
  track_artist: string | null
}

export type ActiveRunsResponse = {
  runs: QueueRunEntry[]
  worker_online: boolean
}

export type BatchTrackIdsInput = {
  track_ids: string[]
}

export type BatchDeleteResponse = {
  deleted_track_count: number
  blocked_track_ids: string[]
  missing_track_ids: string[]
}

export type TempCleanupResponse = {
  deleted_entry_count: number
  bytes_reclaimed: number
}

export type ExportBundleCleanupResponse = {
  deleted_bundle_count: number
  bytes_reclaimed: number
}

export type NonKeeperCleanupResponse = {
  purged_track_count: number
  skipped_track_count: number
  deleted_run_count: number
  bytes_reclaimed: number
}

export type LibraryResetResponse = {
  deleted_track_count: number
  deleted_draft_count: number
  bytes_reclaimed: number
}

export type ExportPackagingMode = 'auto' | 'flat' | 'per-song-folders'
export type ExportDeliveryKind = 'direct-file' | 'flat-zip' | 'folder-zip'
type StaticExportArtifactKind = 'source' | 'metadata' | 'mix-wav' | 'mix-mp3'
type StemExportArtifactKind = `stem-wav:${string}` | `stem-mp3:${string}`
export type ExportArtifactKind = StaticExportArtifactKind | StemExportArtifactKind

export type ExportStemOption = {
  name: string
  label: string
  track_count: number
}

export type ExportStemsInput = {
  track_ids: string[]
  run_ids?: Record<string, string>
}

export type ExportStemsResponse = {
  stems: ExportStemOption[]
}

export type ExportBundleInput = {
  track_ids: string[]
  run_ids?: Record<string, string>
  artifacts: ExportArtifactKind[]
  packaging: ExportPackagingMode
  bitrate: string
}

type ExportBundleSkip = {
  track_id: string
  track_title: string
  reason: string
}

export type ExportBundleResponse = {
  job_id: string
  download_url: string
  filename: string
  delivery: ExportDeliveryKind
  byte_count: number
  included_track_count: number
  skipped: ExportBundleSkip[]
}

export type ExportPlanInput = {
  track_ids: string[]
  run_ids?: Record<string, string>
  artifacts: ExportArtifactKind[]
  packaging: ExportPackagingMode
  bitrate: string
}

type ExportPlanArtifact = {
  kind: ExportArtifactKind
  present: boolean
  size_bytes: number | null
  missing_reason: string | null
}

export type ExportPlanTrack = {
  track_id: string
  track_title: string
  run_id: string | null
  output_label: string | null
  artifacts: ExportPlanArtifact[]
  skip_reason: string | null
}

export type ExportPlanResponse = {
  tracks: ExportPlanTrack[]
  delivery: ExportDeliveryKind | null
  filename: string | null
  included_track_count: number
  total_bytes: number
  skipped_track_count: number
}

type RevealFolderKind = 'exports' | 'outputs' | 'track-outputs' | 'bundle'

export type RevealFolderInput = {
  kind: RevealFolderKind
  track_id?: string | null
  job_id?: string | null
}

export type RevealFolderResponse = {
  path: string
}
