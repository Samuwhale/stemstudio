import { useEffect, useState } from 'react'

import { isMp3Bitrate, MP3_BITRATE_HINT, normalizeMp3Bitrate } from '../bitrate'
import { stemSelectionLabel } from '../stems'
import type { Settings, StorageBucket, StorageOverview } from '../types'
import { Spinner } from './feedback/Spinner'
import { Skeleton } from './feedback/Skeleton'
import { ConfirmInline } from './feedback/ConfirmInline'
import { formatSize } from './metrics'
import { StemSelectionPicker } from './StemSelectionPicker'

type SettingsPanelProps = {
  settings: Settings | null
  storageOverview: StorageOverview | null
  saving: boolean
  cleaningTempStorage: boolean
  cleaningExportBundles: boolean
  cleaningLibraryRuns: boolean
  resettingLibrary: boolean
  view: 'preferences' | 'maintenance' | 'storage'
  onSave: (settings: Omit<Settings, 'stem_options' | 'quality_options'>) => Promise<void>
  onCleanupTempStorage: () => Promise<void>
  onCleanupExportBundles: () => Promise<void>
  onCleanupLibraryRuns: () => void
  onResetLibrary: () => Promise<void>
}

type SettingsDraft = Omit<Settings, 'stem_options' | 'quality_options'>
type DraftState = {
  sourceKey: string
  values: SettingsDraft
}

const STORAGE_PATH_HINT = 'Choose a concrete folder path. Blank values are not allowed.'

function createDraft(settings: Settings | null): SettingsDraft {
  return {
    storage: {
      database_path: settings?.storage.database_path ?? '',
      uploads_directory: settings?.storage.uploads_directory ?? '',
      outputs_directory: settings?.storage.outputs_directory ?? '',
      exports_directory: settings?.storage.exports_directory ?? '',
      temp_directory: settings?.storage.temp_directory ?? '',
      model_cache_directory: settings?.storage.model_cache_directory ?? '',
    },
    retention: {
      temp_max_age_hours: settings?.retention.temp_max_age_hours ?? 24,
      export_bundle_max_age_days: settings?.retention.export_bundle_max_age_days ?? 7,
    },
    default_stem_selection: settings?.default_stem_selection ?? {
      stems: ['instrumental', 'vocals'],
      quality: 'balanced',
      label: 'Instrumental + Vocals',
    },
    export_mp3_bitrate: settings?.export_mp3_bitrate ?? '320k',
  }
}

function bucketFor(storageOverview: StorageOverview | null, key: StorageBucket['key']) {
  return storageOverview?.items.find((item) => item.key === key) ?? null
}

function hasText(value: string) {
  return value.trim().length > 0
}

export function SettingsPanel({
  settings,
  storageOverview,
  saving,
  cleaningTempStorage,
  cleaningExportBundles,
  cleaningLibraryRuns,
  resettingLibrary,
  view,
  onSave,
  onCleanupTempStorage,
  onCleanupExportBundles,
  onCleanupLibraryRuns,
  onResetLibrary,
}: SettingsPanelProps) {
  const settingsKey = settings
    ? [
        settings.storage.database_path,
        settings.storage.uploads_directory,
        settings.storage.outputs_directory,
        settings.storage.exports_directory,
        settings.storage.temp_directory,
        settings.storage.model_cache_directory,
        settings.retention.temp_max_age_hours,
        settings.retention.export_bundle_max_age_days,
        settings.default_stem_selection.stems.join(','),
        settings.default_stem_selection.quality,
        settings.export_mp3_bitrate,
      ].join('|')
    : 'settings'
  const [draftState, setDraftState] = useState<DraftState>(() => ({
    sourceKey: settingsKey,
    values: createDraft(settings),
  }))
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    if (!savedAt) return
    const id = window.setTimeout(() => setSavedAt(null), 5000)
    return () => window.clearTimeout(id)
  }, [savedAt])

  if (view === 'maintenance') {
    return null
  }

  if (!settings) {
    return (
      <section className="section">
        <div className="skeleton-stack">
          <Skeleton height={32} />
          <Skeleton height={32} />
          <Skeleton height={32} />
          <Skeleton height={32} />
          <Skeleton height={32} />
        </div>
      </section>
    )
  }

  const draft = draftState.sourceKey === settingsKey ? draftState.values : createDraft(settings)
  const currentSettings = settings
  const bitrateValid = isMp3Bitrate(draft.export_mp3_bitrate)
  const defaultStemSelectionValid = draft.default_stem_selection.stems.length > 0
  const storagePathsValid =
    hasText(draft.storage.uploads_directory) &&
    hasText(draft.storage.outputs_directory) &&
    hasText(draft.storage.exports_directory) &&
    hasText(draft.storage.temp_directory) &&
    hasText(draft.storage.model_cache_directory)
  const exportBundles = bucketFor(storageOverview, 'export_bundles')
  const outputs = bucketFor(storageOverview, 'outputs')
  const temp = bucketFor(storageOverview, 'temp')

  function updateDraft(nextDraft: SettingsDraft) {
    setDraftState({
      sourceKey: settingsKey,
      values: nextDraft,
    })
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!bitrateValid) return
    if (!defaultStemSelectionValid) return
    if (view === 'storage' && !storagePathsValid) return
    try {
      await onSave({
        ...draft,
        export_mp3_bitrate: normalizeMp3Bitrate(draft.export_mp3_bitrate),
        storage: {
          ...draft.storage,
          database_path: currentSettings.storage.database_path,
        },
      })
      setSavedAt(Date.now())
    } catch {
      // toast surfaces the error; don't flash "Saved."
    }
  }

  return (
    <section className="section">
      {view === 'preferences' ? (
        <form className="import-form" onSubmit={handleSubmit}>
          <div className="processing-grid">
            <div className="field">
              <span>Default stems</span>
              <StemSelectionPicker
                value={draft.default_stem_selection}
                stemOptions={settings.stem_options}
                qualityOptions={settings.quality_options}
                onChange={(next) =>
                  updateDraft({
                    ...draft,
                    default_stem_selection: {
                      ...next,
                      label: stemSelectionLabel(next.stems, settings.stem_options),
                    },
                  })
                }
              />
              <span className="field-hint">Used when creating stems from song rows, imports, and batch actions.</span>
            </div>

            <label className="field">
              <span>Default MP3 bitrate</span>
              <input
                type="text"
                value={draft.export_mp3_bitrate}
                aria-invalid={!bitrateValid}
                onChange={(event) => updateDraft({ ...draft, export_mp3_bitrate: event.target.value })}
              />
              {!bitrateValid ? (
                <span className="field-error">{MP3_BITRATE_HINT}</span>
              ) : (
                <span className="field-hint">Used when exporting MP3 artifacts. Overridable per export.</span>
              )}
            </label>
          </div>

          <div className="import-footer">
            <span>{savedAt ? <span className="field-saved">Saved.</span> : null}</span>
            <button type="submit" className="button-primary" disabled={saving || !bitrateValid || !defaultStemSelectionValid}>
              {saving ? <><Spinner /> Saving…</> : 'Save Preferences'}
            </button>
          </div>
        </form>
      ) : null}

      {view === 'storage' ? (
        <form className="import-form" onSubmit={handleSubmit}>
          <section className="storage-panel-block">
            <div className="subsection-head">Local workspace</div>
            <p className="field-hint">
              Songs, stems, exports, and model files stay on this machine. Use the paths below to see where StemStudio stores them.
            </p>
          </section>

          <section className="storage-panel-block settings-cleanup-block">
            <div className="subsection-head">Reclaim space</div>
            <div className="storage-action-list">
              <div className="storage-action-row">
                <div className="storage-action-copy">
                  <strong>Clear temp workspace</strong>
                  <p>Removes temporary processing files. Safe when you want to reclaim scratch space.</p>
                </div>
                <ConfirmInline
                  label={cleaningTempStorage ? 'Working…' : formatSize(temp?.reclaimable_bytes ?? 0) ?? '0 B'}
                  pendingLabel="Working…"
                  confirmLabel="Clear temp workspace"
                  cancelLabel="Keep temp files"
                  prompt="Delete temporary processing files now?"
                  pending={cleaningTempStorage}
                  disabled={(temp?.reclaimable_bytes ?? 0) === 0}
                  onConfirm={onCleanupTempStorage}
                />
              </div>

              <div className="storage-action-row">
                <div className="storage-action-copy">
                  <strong>Delete export downloads</strong>
                  <p>Removes built export files only. Your saved songs, stem sets, and source files stay intact.</p>
                </div>
                <ConfirmInline
                  label={cleaningExportBundles ? 'Working…' : formatSize(exportBundles?.reclaimable_bytes ?? 0) ?? '0 B'}
                  pendingLabel="Working…"
                  confirmLabel="Delete export downloads"
                  cancelLabel="Keep exports"
                  prompt="Delete built export downloads now?"
                  pending={cleaningExportBundles}
                  disabled={(exportBundles?.reclaimable_bytes ?? 0) === 0}
                  onConfirm={onCleanupExportBundles}
                />
              </div>

              <div className="storage-action-row">
                <div className="storage-action-copy">
                  <strong>Purge non-preferred stem sets</strong>
                  <p>Deletes stem sets that are not marked as preferred. Use this only after you have chosen winners.</p>
                </div>
                <ConfirmInline
                  label={cleaningLibraryRuns ? 'Working…' : formatSize(outputs?.reclaimable_bytes ?? 0) ?? '0 B'}
                  pendingLabel="Working…"
                  confirmLabel="Purge non-preferred stem sets"
                  cancelLabel="Keep all stem sets"
                  prompt="Delete non-preferred stem sets across the library?"
                  pending={cleaningLibraryRuns}
                  disabled={(outputs?.reclaimable_bytes ?? 0) === 0}
                  onConfirm={async () => onCleanupLibraryRuns()}
                />
              </div>

              <div className="storage-action-row storage-action-row-danger">
                <div className="storage-action-copy">
                  <strong>Clear all songs &amp; data</strong>
                  <p>Deletes every imported song, stem set, export, and pending import. The processing model cache is kept so future splits stay fast.</p>
                </div>
                <ConfirmInline
                  label={resettingLibrary ? 'Working…' : 'Clear everything'}
                  pendingLabel="Working…"
                  confirmLabel="Delete all songs"
                  cancelLabel="Keep my library"
                  prompt="Delete every song, stem set, and import?"
                  pending={resettingLibrary}
                  onConfirm={onResetLibrary}
                />
              </div>
            </div>
          </section>

          <section className="storage-panel-block">
            <div className="subsection-head">Workspace usage</div>
            <div className="storage-usage-list">
              {(storageOverview?.items ?? []).map((item) => (
                <article key={item.key} className="storage-usage-row">
                  <div className="storage-usage-copy">
                    <strong>{item.label}</strong>
                    <p>{item.path}</p>
                  </div>
                  <div className="storage-usage-metrics">
                    <span>{formatSize(item.total_bytes)}</span>
                    <span>
                      {item.reclaimable_bytes > 0
                        ? `${formatSize(item.reclaimable_bytes)} reclaimable`
                        : 'No cleanup action'}
                    </span>
                  </div>
                </article>
              ))}
            </div>
            {!storageOverview ? (
              <div className="skeleton-stack">
                <Skeleton height={36} />
                <Skeleton height={36} />
                <Skeleton height={36} />
              </div>
            ) : null}
          </section>

          <details className="storage-panel-block storage-paths-collapsible">
            <summary className="subsection-head">Storage paths &amp; retention</summary>
            <div className="storage-path-grid">
              <label className="field">
                <span>Database path</span>
                <input type="text" value={draft.storage.database_path} readOnly />
              </label>

              <label className="field">
                <span>Uploads directory</span>
                <input
                  type="text"
                  value={draft.storage.uploads_directory}
                  aria-invalid={!hasText(draft.storage.uploads_directory)}
                  onChange={(event) =>
                    updateDraft({
                      ...draft,
                      storage: { ...draft.storage, uploads_directory: event.target.value },
                    })
                  }
                />
                {!hasText(draft.storage.uploads_directory) ? (
                  <span className="field-error">{STORAGE_PATH_HINT}</span>
                ) : null}
              </label>

              <label className="field">
                <span>Outputs directory</span>
                <input
                  type="text"
                  value={draft.storage.outputs_directory}
                  aria-invalid={!hasText(draft.storage.outputs_directory)}
                  onChange={(event) =>
                    updateDraft({
                      ...draft,
                      storage: { ...draft.storage, outputs_directory: event.target.value },
                    })
                  }
                />
                {!hasText(draft.storage.outputs_directory) ? (
                  <span className="field-error">{STORAGE_PATH_HINT}</span>
                ) : null}
              </label>

              <label className="field">
                <span>Exports directory</span>
                <input
                  type="text"
                  value={draft.storage.exports_directory}
                  aria-invalid={!hasText(draft.storage.exports_directory)}
                  onChange={(event) =>
                    updateDraft({
                      ...draft,
                      storage: { ...draft.storage, exports_directory: event.target.value },
                    })
                  }
                />
                {!hasText(draft.storage.exports_directory) ? (
                  <span className="field-error">{STORAGE_PATH_HINT}</span>
                ) : null}
              </label>

              <label className="field">
                <span>Temp directory</span>
                <input
                  type="text"
                  value={draft.storage.temp_directory}
                  aria-invalid={!hasText(draft.storage.temp_directory)}
                  onChange={(event) =>
                    updateDraft({
                      ...draft,
                      storage: { ...draft.storage, temp_directory: event.target.value },
                    })
                  }
                />
                {!hasText(draft.storage.temp_directory) ? (
                  <span className="field-error">{STORAGE_PATH_HINT}</span>
                ) : null}
              </label>

              <label className="field">
                <span>Processing cache directory</span>
                <input
                  type="text"
                  value={draft.storage.model_cache_directory}
                  aria-invalid={!hasText(draft.storage.model_cache_directory)}
                  onChange={(event) =>
                    updateDraft({
                      ...draft,
                      storage: { ...draft.storage, model_cache_directory: event.target.value },
                    })
                  }
                />
                {!hasText(draft.storage.model_cache_directory) ? (
                  <span className="field-error">{STORAGE_PATH_HINT}</span>
                ) : null}
              </label>
            </div>

            <div className="storage-panel-subhead">Retention</div>
            <div className="processing-grid">
              <label className="field">
                <span>Temp max age (hours)</span>
                <input
                  type="number"
                  min={1}
                  value={draft.retention.temp_max_age_hours}
                  onChange={(event) =>
                    updateDraft({
                      ...draft,
                      retention: {
                        ...draft.retention,
                        temp_max_age_hours: Math.max(1, Number(event.target.value) || 1),
                      },
                    })
                  }
                />
              </label>

              <label className="field">
                <span>Export download max age (days)</span>
                <input
                  type="number"
                  min={1}
                  value={draft.retention.export_bundle_max_age_days}
                  onChange={(event) =>
                    updateDraft({
                      ...draft,
                      retention: {
                        ...draft.retention,
                        export_bundle_max_age_days: Math.max(1, Number(event.target.value) || 1),
                      },
                    })
                  }
                />
              </label>
            </div>
          </details>

          <div className="import-footer">
            <span>{savedAt ? <span className="field-saved">Storage settings saved.</span> : null}</span>
            <button type="submit" className="button-primary" disabled={saving || !bitrateValid || !storagePathsValid}>
              {saving ? <><Spinner /> Saving…</> : 'Save Storage Settings'}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  )
}
