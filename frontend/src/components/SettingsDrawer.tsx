import { useRef, useState } from 'react'

import { useDialogFocus } from '../hooks/useDialogFocus'
import type { Diagnostics, Settings, StorageOverview } from '../types'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { SettingsPanel } from './SettingsPanel'

type SettingsDrawerProps = {
  open: boolean
  initialView: 'preferences' | 'maintenance' | 'storage'
  diagnostics: Diagnostics | null
  settings: Settings | null
  storageOverview: StorageOverview | null
  storageOverviewError: string | null
  savingSettings: boolean
  cleaningTempStorage: boolean
  cleaningExportBundles: boolean
  cleaningLibraryRuns: boolean
  resettingLibrary: boolean
  backfillingMetrics: boolean
  onClose: () => void
  onSaveSettings: (settings: Omit<Settings, 'stem_options' | 'quality_options'>) => Promise<void>
  onCleanupTempStorage: () => Promise<void>
  onCleanupExportBundles: () => Promise<void>
  onCleanupLibraryRuns: () => void
  onResetLibrary: () => Promise<void>
  onBackfillMetrics: () => Promise<void>
}

export function SettingsDrawer({
  open,
  ...props
}: SettingsDrawerProps) {
  if (!open) return null
  return (
    <SettingsDrawerContent
      key={props.initialView}
      {...props}
      open={open}
      initialView={props.initialView}
    />
  )
}

type SettingsDrawerContentProps = SettingsDrawerProps & {
  initialView: 'preferences' | 'maintenance' | 'storage'
}

function SettingsDrawerContent({
  open,
  diagnostics,
  settings,
  storageOverview,
  storageOverviewError,
  savingSettings,
  cleaningTempStorage,
  cleaningExportBundles,
  cleaningLibraryRuns,
  resettingLibrary,
  backfillingMetrics,
  onClose,
  onSaveSettings,
  onCleanupTempStorage,
  onCleanupExportBundles,
  onCleanupLibraryRuns,
  onResetLibrary,
  onBackfillMetrics,
  initialView,
}: SettingsDrawerContentProps) {
  const panelRef = useRef<HTMLElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  useDialogFocus(open, { containerRef: panelRef, initialFocusRef: closeButtonRef })
  const [view, setView] = useState<'preferences' | 'maintenance' | 'storage'>(initialView)
  const readinessBlocked = (diagnostics?.issues.length ?? 0) > 0
  const separationBlocked = diagnostics ? !diagnostics.separation_ready : false

  const drawerTitle =
    view === 'maintenance' && (readinessBlocked || separationBlocked) ? 'Finish setup' : 'Settings'
  const drawerDescription =
    view === 'preferences'
      ? 'Set the defaults used when you create stems or export.'
      : view === 'maintenance'
        ? readinessBlocked
          ? 'Processing is blocked. Fix the setup issue first, then return to the workspace.'
          : separationBlocked
            ? 'The library is ready. Install audio-separator before creating stems.'
            : 'Check readiness, then repair anything blocking the workspace.'
        : 'Reclaim disk space, review workspace usage, and tune paths when the layout needs to change.'

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <aside className="drawer-panel" ref={panelRef} tabIndex={-1}>
        <header className="drawer-head">
          <div className="drawer-head-copy">
            <h2>{drawerTitle}</h2>
            <p>{drawerDescription}</p>
          </div>
          <button ref={closeButtonRef} type="button" className="button-secondary" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="drawer-body">
          <div className="drawer-tabs" role="tablist" aria-label="Settings sections">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'preferences'}
              className={`drawer-tab ${view === 'preferences' ? 'drawer-tab-active' : ''}`}
              onClick={() => setView('preferences')}
            >
              Defaults
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'maintenance'}
              className={`drawer-tab ${view === 'maintenance' ? 'drawer-tab-active' : ''}`}
              onClick={() => setView('maintenance')}
            >
              Setup
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'storage'}
              className={`drawer-tab ${view === 'storage' ? 'drawer-tab-active' : ''}`}
              onClick={() => setView('storage')}
            >
              Storage
            </button>
          </div>
          {view === 'maintenance' ? (
            <DiagnosticsPanel
              diagnostics={diagnostics}
              backfillingMetrics={backfillingMetrics}
              onBackfillMetrics={onBackfillMetrics}
            />
          ) : null}
          <SettingsPanel
            settings={settings}
            storageOverview={storageOverview}
            storageOverviewError={storageOverviewError}
            saving={savingSettings}
            cleaningTempStorage={cleaningTempStorage}
            cleaningExportBundles={cleaningExportBundles}
            cleaningLibraryRuns={cleaningLibraryRuns}
            resettingLibrary={resettingLibrary}
            view={view}
            onSave={onSaveSettings}
            onCleanupTempStorage={onCleanupTempStorage}
            onCleanupExportBundles={onCleanupExportBundles}
            onCleanupLibraryRuns={onCleanupLibraryRuns}
            onResetLibrary={onResetLibrary}
          />
        </div>
      </aside>
    </div>
  )
}
