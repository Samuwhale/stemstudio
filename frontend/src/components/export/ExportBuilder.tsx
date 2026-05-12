import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { discardRejection } from '../../async'
import { createExportBundle, listExportStems, planExportBundle } from '../../api'
import { isMp3Bitrate, MP3_BITRATE_HINT, normalizeMp3Bitrate } from '../../bitrate'
import type {
  ExportArtifactKind,
  ExportBundleResponse,
  ExportDeliveryKind,
  ExportPackagingMode,
  ExportPlanResponse,
  ExportPlanTrack,
  ExportStemOption,
  RevealFolderInput,
} from '../../types'
import { exportStemKind, stemLabel } from '../../stems'
import { formatSize } from '../metrics'
import { Spinner } from '../feedback/Spinner'

type Format = 'mp3' | 'wav'
const EMPTY_RUN_IDS: Record<string, string> = {}

type ExportBuilderProps = {
  selectedTrackIds: string[]
  defaultBitrate: string
  runIds?: Record<string, string>
  onError: (message: string) => void
  onReveal: (payload: RevealFolderInput) => void | Promise<void>
  footerAction?: React.ReactNode
  variant?: 'full' | 'compact'
}

function buildArtifactList(
  includeMix: boolean,
  selectedStems: Set<string>,
  includeSource: boolean,
  stemOptions: ExportStemOption[],
  mixFmt: Format,
  stemFmt: Format,
): ExportArtifactKind[] {
  const kinds: ExportArtifactKind[] = []
  if (includeMix) kinds.push(mixFmt === 'wav' ? 'mix-wav' : 'mix-mp3')
  for (const option of stemOptions) {
    if (selectedStems.has(option.name)) {
      kinds.push(exportStemKind(option.name, stemFmt) as ExportArtifactKind)
    }
  }
  if (includeSource) kinds.push('source')
  return kinds
}

function stemAvailabilityHint(option: ExportStemOption, totalTracks: number): string {
  if (totalTracks <= 1) return 'Separated stem from this track.'
  if (option.track_count >= totalTracks) return `Available in all ${totalTracks} tracks.`
  return `Available in ${option.track_count} of ${totalTracks} tracks.`
}

function deliverySummary(delivery: ExportDeliveryKind): string {
  if (delivery === 'direct-file') return 'Downloads as a single file.'
  if (delivery === 'flat-zip') return 'Downloads as one zip with all files at the top level.'
  return 'Downloads as one zip with one folder per song.'
}

function packagingSummary(packaging: ExportPackagingMode): string {
  if (packaging === 'flat') return 'All exported files go into one flat folder in the zip.'
  return 'Each song gets its own folder in the zip.'
}

function buildRunIdsKey(runIds: Record<string, string> | undefined): string {
  return Object.entries(runIds ?? {})
    .sort()
    .map(([trackId, runId]) => `${trackId}=${runId}`)
    .join('|')
}

export function ExportBuilder(props: ExportBuilderProps) {
  const variant = props.variant ?? 'full'
  const selectedTrackIdsKey = props.selectedTrackIds.join(',')
  const runIdsKey = buildRunIdsKey(props.runIds)
  const resetKey = `${variant}|${selectedTrackIdsKey}|${runIdsKey}|${props.defaultBitrate}`

  return <ExportBuilderContent key={resetKey} {...props} variant={variant} />
}

function ExportBuilderContent({
  selectedTrackIds,
  defaultBitrate,
  runIds,
  onError,
  onReveal,
  footerAction,
  variant = 'full',
}: ExportBuilderProps) {
  const resolvedRunIds = useMemo(() => runIds ?? EMPTY_RUN_IDS, [runIds])
  const [loadedStemOptions, setLoadedStemOptions] = useState<{
    key: string
    stems: ExportStemOption[]
    error: string | null
  } | null>(null)
  const [includeMix, setIncludeMix] = useState(true)
  const [selectedStems, setSelectedStems] = useState<Set<string>>(() => new Set())
  const [includeSource, setIncludeSource] = useState(false)
  const [showArtifactDetails, setShowArtifactDetails] = useState(false)
  const [mixFmt, setMixFmt] = useState<Format>('mp3')
  const [stemFmt, setStemFmt] = useState<Format>('wav')
  const [packaging, setPackaging] = useState<ExportPackagingMode>('per-song-folders')
  const [bitrate, setBitrate] = useState(defaultBitrate)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExportBundleResponse | null>(null)
  const [plannedResponse, setPlannedResponse] = useState<{
    key: string
    plan: ExportPlanResponse | null
    error: string | null
  } | null>(null)
  const doneButtonRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (result) doneButtonRef.current?.focus()
  }, [result])

  const selectedTrackIdsKey = useMemo(() => selectedTrackIds.join(','), [selectedTrackIds])
  const runIdsKey = useMemo(() => buildRunIdsKey(runIds), [runIds])
  const stemOptionsKey = `${selectedTrackIdsKey}|${runIdsKey}`

  const stemOptions = useMemo(
    () => (loadedStemOptions?.key === stemOptionsKey ? loadedStemOptions.stems : []),
    [loadedStemOptions, stemOptionsKey],
  )
  const stemLookupError = loadedStemOptions?.key === stemOptionsKey ? loadedStemOptions.error : null
  const stemsLoading = selectedTrackIds.length > 0 && loadedStemOptions?.key !== stemOptionsKey
  const hasStems = stemOptions.length > 0
  const multiTrack = selectedTrackIds.length > 1
  const effectivePackaging: ExportPackagingMode = multiTrack ? packaging : 'auto'

  useEffect(() => {
    if (!selectedTrackIds.length) return
    let cancelled = false

    listExportStems({ track_ids: selectedTrackIds, run_ids: resolvedRunIds })
      .then((response) => {
        if (!cancelled) {
          setLoadedStemOptions({ key: stemOptionsKey, stems: response.stems, error: null })
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadedStemOptions({
            key: stemOptionsKey,
            stems: [],
            error: error instanceof Error ? error.message : 'Could not load stem availability.',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [resolvedRunIds, selectedTrackIds, stemOptionsKey])

  const hasSelectedStems = useMemo(
    () => stemOptions.some((option) => selectedStems.has(option.name)),
    [stemOptions, selectedStems],
  )

  const artifactList = useMemo(
    () => buildArtifactList(includeMix, selectedStems, includeSource, stemOptions, mixFmt, stemFmt),
    [includeMix, selectedStems, includeSource, stemOptions, mixFmt, stemFmt],
  )
  const normalizedBitrate = normalizeMp3Bitrate(bitrate)
  const bitrateValid = isMp3Bitrate(bitrate)
  const mp3Requested = (includeMix && mixFmt === 'mp3') || (hasSelectedStems && stemFmt === 'mp3')
  const showBitrateField = mp3Requested && (showArtifactDetails || !bitrateValid)
  const planKey = useMemo(() => {
    return `${selectedTrackIdsKey}|${runIdsKey}|${artifactList.slice().sort().join(',')}|${effectivePackaging}|${normalizedBitrate}`
  }, [selectedTrackIdsKey, runIdsKey, artifactList, effectivePackaging, normalizedBitrate])
  const canPlan = !!selectedTrackIds.length && !!artifactList.length && (!mp3Requested || bitrateValid)
  const plan = canPlan && plannedResponse?.key === planKey ? plannedResponse.plan : null
  const planError = canPlan && plannedResponse?.key === planKey ? plannedResponse.error : null
  const planLoading = canPlan && plannedResponse?.key !== planKey

  useEffect(() => {
    if (result || !canPlan) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      try {
        const response = await planExportBundle({
          track_ids: selectedTrackIds,
          run_ids: resolvedRunIds,
          artifacts: artifactList,
          packaging: effectivePackaging,
          bitrate: normalizedBitrate,
        })
        if (!cancelled) {
          setPlannedResponse({ key: planKey, plan: response, error: null })
        }
      } catch (error) {
        if (!cancelled) {
          setPlannedResponse({
            key: planKey,
            plan: null,
            error: error instanceof Error ? error.message : 'Could not check export availability.',
          })
        }
      }
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [artifactList, canPlan, effectivePackaging, normalizedBitrate, planKey, resolvedRunIds, result, selectedTrackIds])

  async function handleExport() {
    if (!artifactList.length) return
    if (mp3Requested && !bitrateValid) return
    setBusy(true)
    try {
      const response = await createExportBundle({
        track_ids: selectedTrackIds,
        run_ids: resolvedRunIds,
        artifacts: artifactList,
        packaging: effectivePackaging,
        bitrate: normalizedBitrate,
      })
      setResult(response)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setBusy(false)
    }
  }

  function useCurrentMixOnly() {
    setIncludeMix(true)
    setSelectedStems(new Set())
    setIncludeSource(false)
    setShowArtifactDetails(false)
  }

  const includedCount = plan?.included_track_count ?? 0
  const skippedCount = plan?.skipped_track_count ?? 0
  const totalBytes = plan?.total_bytes ?? 0
  const exportingOnlyCurrentMix = includeMix && !hasSelectedStems && !includeSource
  const exportButtonLabel = exportingOnlyCurrentMix ? 'Export current mix' : 'Export files'
  const mixFormatSummary = mixFmt === 'mp3' ? `MP3 ${normalizedBitrate}k` : 'WAV'
  const stemFormatSummary = stemFmt === 'mp3' ? `MP3 ${normalizedBitrate}k` : 'WAV'
  const choiceParts = [
    includeMix ? `mix ${mixFormatSummary}` : null,
    hasSelectedStems ? `stems ${stemFormatSummary}` : null,
    includeSource ? 'original song' : null,
  ].filter(Boolean)
  const compactChoiceSummary = exportingOnlyCurrentMix
    ? `Current mix · ${mixFormatSummary}`
    : `Files · ${choiceParts.join(' · ')}`

  const blockingReason = !selectedTrackIds.length
    ? 'Choose at least one track to export.'
    : mp3Requested && !bitrateValid
      ? MP3_BITRATE_HINT
    : !artifactList.length
      ? 'Pick at least one audio file to include.'
      : planLoading
        ? 'Checking export files…'
      : planError
        ? planError
        : plan && includedCount === 0
          ? 'None of the selected tracks have the files required for this export.'
          : null
  const exportDisabled =
    busy ||
    !artifactList.length ||
    !selectedTrackIds.length ||
    planLoading ||
    !!planError ||
    (canPlan && plan === null) ||
    (plan !== null && includedCount === 0) ||
    (mp3Requested && !bitrateValid)

  if (result) {
    return (
      <div className="export-result">
        <strong>Built {result.filename}</strong>
        <p>
          {result.included_track_count} track{result.included_track_count === 1 ? '' : 's'} included ·{' '}
          {formatSize(result.byte_count)} · {deliverySummary(result.delivery)}
        </p>
        {result.skipped.length ? (
          <details className="export-result-skipped">
            <summary>{result.skipped.length} skipped</summary>
            <ul>
              {result.skipped.map((skip) => (
                <li key={skip.track_id}>
                  <strong>{skip.track_title}</strong>: {skip.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="export-result-actions">
          <a className="button-primary" href={result.download_url} download={result.filename}>
            {result.delivery === 'direct-file' ? 'Download file' : 'Download zip'}
          </a>
          <button
            type="button"
            className="button-secondary"
            onClick={() => discardRejection(() => onReveal({ kind: 'bundle', job_id: result.job_id }))}
          >
            Reveal in Finder
          </button>
          <button type="button" className="button-secondary" onClick={() => setResult(null)}>
            Export again
          </button>
          {footerAction ? (
            <div className="export-result-extra-action" ref={doneButtonRef} tabIndex={-1}>
              {footerAction}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="export-builder">
      <div className="export-pop-rows">
        <IncludeRow
          checked={includeMix}
          onToggle={() => setIncludeMix((value) => !value)}
          label="Current mix"
          hint="One playable file using the current levels and mutes."
          format={mixFmt}
          onFormatChange={setMixFmt}
        />
        {!showArtifactDetails ? (
          <button
            type="button"
            className="export-disclosure-row"
            onClick={() => setShowArtifactDetails(true)}
          >
            <strong>Add stems or source</strong>
            <span>Add separated stems or the original song when you need files for a DAW.</span>
          </button>
        ) : null}
        {showArtifactDetails ? (
          <>
            <button
              type="button"
              className="export-disclosure-row export-disclosure-row-open"
              onClick={useCurrentMixOnly}
            >
              <strong>Use current mix only</strong>
              <span>Export one playable file using the current levels and mutes.</span>
            </button>
            {stemsLoading || stemLookupError || !hasStems ? (
              <StemStatusRow
                hint={
                  stemsLoading
                    ? 'Looking up available stems…'
                    : stemLookupError
                      ? 'Could not load stem availability.'
                      : 'No separated stems available for this selection.'
                }
              />
            ) : (
              stemOptions.map((option) => (
                <IncludeRow
                  key={option.name}
                  checked={selectedStems.has(option.name)}
                  onToggle={() =>
                    setSelectedStems((current) => {
                      const next = new Set(current)
                      if (next.has(option.name)) next.delete(option.name)
                      else next.add(option.name)
                      return next
                    })
                  }
                  label={option.label}
                  hint={stemAvailabilityHint(option, selectedTrackIds.length)}
                />
              ))
            )}
            {hasStems ? (
              <div className="export-stem-format">
                <span>Separated stem format</span>
                <div className="import-source-toggle">
                  <button
                    type="button"
                    className={`segmented ${stemFmt === 'mp3' ? 'segmented-active' : ''}`}
                    onClick={() => setStemFmt('mp3')}
                  >
                    MP3
                  </button>
                  <button
                    type="button"
                    className={`segmented ${stemFmt === 'wav' ? 'segmented-active' : ''}`}
                    onClick={() => setStemFmt('wav')}
                  >
                    WAV
                  </button>
                </div>
              </div>
            ) : null}
            <IncludeRow
              checked={includeSource}
              onToggle={() => setIncludeSource((value) => !value)}
              label="Original song"
              hint="The imported source audio, alongside the export."
            />
          </>
        ) : null}
      </div>

      {showBitrateField ? (
        <label className="export-bitrate-field">
          <span>MP3 bitrate</span>
          <input
            type="text"
            value={bitrate}
            aria-invalid={!bitrateValid}
            onChange={(event) => setBitrate(event.target.value)}
          />
          {!bitrateValid ? <span className="field-error">{MP3_BITRATE_HINT}</span> : null}
        </label>
      ) : null}

      {multiTrack && showArtifactDetails ? (
        <div className="export-pack">
          <span>Packaging</span>
          <div className="import-source-toggle">
            <button
              type="button"
              className={`segmented ${packaging === 'per-song-folders' ? 'segmented-active' : ''}`}
              onClick={() => setPackaging('per-song-folders')}
            >
              Per song folders
            </button>
            <button
              type="button"
              className={`segmented ${packaging === 'flat' ? 'segmented-active' : ''}`}
              onClick={() => setPackaging('flat')}
            >
              One flat folder
            </button>
          </div>
          <p className="inline-hint">{packagingSummary(packaging)} Every file still includes the song name.</p>
        </div>
      ) : null}

      {variant === 'full' && showArtifactDetails ? (
        <section className="export-manifest-section">
          <div className="export-manifest-head-bar">
            <span>Included</span>
            <span className="export-manifest-count">
              {planLoading && !plan
                ? 'Checking…'
                : plan
                  ? `${includedCount} ready · ${skippedCount} skipped · ${formatSize(totalBytes)}`
                  : ''}
            </span>
          </div>
          {plan?.delivery ? <p className="inline-hint">{deliverySummary(plan.delivery)}</p> : null}
          {plan?.filename ? <p className="inline-hint">Download name: {plan.filename}</p> : null}
          {plan ? (
            <ExportManifest plan={plan} artifactList={artifactList} stemOptions={stemOptions} />
          ) : planError ? (
            <p className="inline-hint">{planError}</p>
          ) : planLoading ? (
            <p className="inline-hint">
              <Spinner /> Checking which artifacts are available…
            </p>
          ) : (
            <p className="inline-hint">Pick at least one audio file to see what will be in the export.</p>
          )}
        </section>
      ) : (
        <p className="export-compact-summary" aria-live="polite">
          {!artifactList.length
            ? 'Pick at least one audio file to export.'
            : planLoading && !plan
              ? 'Estimating size…'
              : planError
                ? planError
                  : plan
                  ? `${compactChoiceSummary} · ${formatSize(totalBytes)}${skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}${plan.delivery ? ` · ${deliverySummary(plan.delivery)}` : ''}`
                  : exportingOnlyCurrentMix
                    ? `${compactChoiceSummary} · Uses current levels and mutes.`
                    : ''}
        </p>
      )}

      <div className="import-footer">
        <span>{blockingReason ?? (busy ? 'Building export…' : '')}</span>
        <div className="export-builder-actions">
          {footerAction}
          <button
            type="button"
            className="button-primary"
            disabled={exportDisabled}
            onClick={() => discardRejection(handleExport)}
          >
            {busy ? (
              <>
                <Spinner /> Exporting…
              </>
            ) : planLoading ? (
              <>
                <Spinner /> Checking…
              </>
            ) : (
              exportButtonLabel
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

type IncludeRowProps = {
  checked: boolean
  disabled?: boolean
  onToggle: () => void
  label: string
  hint: string
  format?: Format
  onFormatChange?: (next: Format) => void
}

function StemStatusRow({ hint }: { hint: string }) {
  return (
    <div className="export-pop-row is-disabled" aria-disabled>
      <span aria-hidden />
      <div className="export-pop-row-copy">
        <strong>Separated stems</strong>
        <span>{hint}</span>
      </div>
    </div>
  )
}

function IncludeRow({ checked, disabled, onToggle, label, hint, format, onFormatChange }: IncludeRowProps) {
  return (
    <div
      className={`export-pop-row ${checked ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`}
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={() => {
        if (!disabled) onToggle()
      }}
      onKeyDown={(event) => {
        if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onToggle()
      }}
    >
      <div className="export-pop-row-check">
        <input type="checkbox" checked={checked} disabled={disabled} readOnly tabIndex={-1} aria-hidden />
        <span className="export-pop-row-copy">
          <strong>{label}</strong>
          <span>{hint}</span>
        </span>
      </div>
      {format && onFormatChange ? (
        <div
          className="import-source-toggle export-pop-row-fmt"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={`segmented ${format === 'mp3' ? 'segmented-active' : ''}`}
            disabled={!checked || disabled}
            onClick={() => onFormatChange('mp3')}
          >
            MP3
          </button>
          <button
            type="button"
            className={`segmented ${format === 'wav' ? 'segmented-active' : ''}`}
            disabled={!checked || disabled}
            onClick={() => onFormatChange('wav')}
          >
            WAV
          </button>
        </div>
      ) : null}
    </div>
  )
}

type ExportManifestProps = {
  plan: ExportPlanResponse
  artifactList: ExportArtifactKind[]
  stemOptions: ExportStemOption[]
}

function ExportManifest({ plan, artifactList, stemOptions }: ExportManifestProps) {
  if (!plan.tracks.length) {
    return <p className="inline-hint">No tracks selected.</p>
  }

  return (
    <ul className="export-manifest">
      {plan.tracks.map((track) => (
        <ManifestRow
          key={track.track_id}
          track={track}
          artifactList={artifactList}
          stemOptions={stemOptions}
        />
      ))}
    </ul>
  )
}

type ManifestRowProps = {
  track: ExportPlanTrack
  artifactList: ExportArtifactKind[]
  stemOptions: ExportStemOption[]
}

const ManifestRow = memo(function ManifestRow({ track, artifactList, stemOptions }: ManifestRowProps) {
  const presentMap = useMemo(
    () => new Map(track.artifacts.map((artifact) => [artifact.kind, artifact])),
    [track.artifacts],
  )

  return (
    <li className={`export-manifest-row ${track.skip_reason ? 'export-manifest-row-skipped' : ''}`}>
      <div className="export-manifest-head">
        <strong>{track.track_title}</strong>
        {track.output_label ? <span>{track.output_label}</span> : null}
      </div>
      {track.skip_reason ? (
        <div className="export-manifest-skip">{track.skip_reason}</div>
      ) : (
        <ul className="export-manifest-artifacts">
          {artifactList.map((kind) => {
            const match = presentMap.get(kind)
            const present = match?.present ?? false
            return (
              <li
                key={kind}
                className={`export-manifest-artifact ${present ? 'is-present' : 'is-missing'}`}
                title={match?.missing_reason ?? undefined}
              >
                <span aria-hidden>{present ? '✓' : '-'}</span>
                <span>{artifactLabel(kind, stemOptions)}</span>
                {present && match?.size_bytes != null ? (
                  <span className="export-manifest-size">{formatSize(match.size_bytes)}</span>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
})

function artifactLabel(value: ExportArtifactKind, stems: ExportStemOption[]): string {
  if (value === 'mix-mp3') return 'Mix MP3'
  if (value === 'mix-wav') return 'Mix WAV'
  if (value === 'source') return 'Source'
  if (value === 'metadata') return 'Metadata'
  if (value.startsWith('stem-mp3:')) {
    const name = value.slice('stem-mp3:'.length)
    const stem = stems.find((item) => item.name === name)
    return `${stem?.label ?? stemLabel(name)} MP3`
  }
  if (value.startsWith('stem-wav:')) {
    const name = value.slice('stem-wav:'.length)
    const stem = stems.find((item) => item.name === name)
    return `${stem?.label ?? stemLabel(name)} WAV`
  }
  return value
}
