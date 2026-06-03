import { discardRejection } from '../async'
import type { Diagnostics, BinaryStatus } from '../types'
import { Skeleton } from './feedback/Skeleton'
import { Spinner } from './feedback/Spinner'

type DiagnosticsPanelProps = {
  diagnostics: Diagnostics | null
  backfillingMetrics: boolean
  onBackfillMetrics: () => Promise<void>
}

const REMEDIATION: { pattern: RegExp; hint: string }[] = [
  { pattern: /yt-dlp/i, hint: 'Rebuild the bundled runtime with `npm run desktop:runtime`.' },
  { pattern: /ffmpeg|ffprobe/i, hint: 'Rebuild the bundled runtime with `npm run desktop:runtime`.' },
  { pattern: /audio-separator/i, hint: 'Rebuild the bundled runtime with `npm run desktop:runtime`.' },
  { pattern: /storage|configured output directory|processing cache directory/i, hint: 'Choose separate writable folders in Storage.' },
  { pattern: /disk/i, hint: 'Free up space in the output or processing cache directories.' },
]

function remediationFor(issue: string): string | null {
  const match = REMEDIATION.find((entry) => entry.pattern.test(issue))
  return match?.hint ?? null
}

function binaryStatusLabel(binary: BinaryStatus) {
  if (binary.available) return 'ready'
  if (binary.path) return binary.required ? 'not runnable: required' : 'not runnable'
  return binary.required ? 'missing: required' : 'missing'
}

function binaryStatusTone(binary: BinaryStatus) {
  if (binary.available) return 'status-ok'
  return binary.required ? 'status-err' : 'status-warn'
}

export function DiagnosticsPanel({
  diagnostics,
  backfillingMetrics,
  onBackfillMetrics,
}: DiagnosticsPanelProps) {
  if (!diagnostics) {
    return (
      <section className="section">
        <div className="section-head">
          <h2>Readiness</h2>
        </div>
        <div className="skeleton-stack">
          <Skeleton height={24} />
          <Skeleton height={24} />
          <Skeleton height={24} />
        </div>
      </section>
    )
  }

  const blockingIssue = diagnostics.issues[0] ?? null
  const separatorAvailable = diagnostics.binaries.find((binary) => binary.name === 'audio-separator')?.available ?? false
  const readinessSummary = diagnostics.issues.length
    ? 'Resolve the setup issue below, then return to the workspace.'
    : diagnostics.separation_ready
      ? 'System checks look good. Stem creation should be ready to run.'
      : 'The library is ready. Install audio-separator when you want to create stems.'
  const readinessTitle = diagnostics.issues.length
    ? 'Setup needs attention'
    : diagnostics.separation_ready
      ? 'Stem creation is ready'
      : 'Library is ready'

  return (
    <section className="section">
      <div className="section-head">
        <h2>Readiness</h2>
      </div>

      <div className="diagnostics-callout">
        <strong>{readinessTitle}</strong>
        <p>{readinessSummary}</p>
        {blockingIssue ? <span>{blockingIssue}</span> : null}
      </div>

      {diagnostics.issues.length ? (
        <div className="diagnostics-issues" role="alert">
          <strong>
            {diagnostics.issues.length} issue{diagnostics.issues.length === 1 ? '' : 's'} blocking
            processing
          </strong>
          <ul>
            {diagnostics.issues.map((issue) => {
              const remediation = remediationFor(issue)
              return (
                <li key={issue}>
                  {issue}
                  {remediation ? <span className="diagnostics-hint">: {remediation}</span> : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      <div className="metric-line diagnostics-summary">
        <div>
          <span>Acceleration</span>
          <strong>{diagnostics.acceleration}</strong>
        </div>
        <div>
          <span>Free disk now</span>
          <strong>{diagnostics.free_disk_gb} GB</strong>
        </div>
        <div>
          <span>Stem creation</span>
          <strong>{separatorAvailable ? 'Ready' : 'Needs audio-separator'}</strong>
        </div>
        <div>
          <span>YouTube import</span>
          <strong>{diagnostics.url_import_ready ? 'Ready' : 'Needs yt-dlp'}</strong>
        </div>
      </div>

      <details className="advanced-actions">
        <summary>Tool paths</summary>
        <div className="row-list">
          {diagnostics.binaries.map((binary) => {
            const tone = binaryStatusTone(binary)
            const label = binaryStatusLabel(binary)
            return (
              <article key={binary.name} className="row-line">
                <div>
                  <strong>{binary.name}</strong>
                  <p>{binary.path ?? 'not on PATH'}</p>
                </div>
                <span className={`status-word ${tone}`}>{label}</span>
              </article>
            )
          })}
        </div>
      </details>
      <details className="advanced-actions">
        <summary>Library repair</summary>
        <button
          type="button"
          className="button-secondary"
          disabled={backfillingMetrics}
          onClick={() => discardRejection(onBackfillMetrics)}
        >
          {backfillingMetrics ? <><Spinner /> Backfilling…</> : 'Backfill quality metrics'}
        </button>
      </details>
    </section>
  )
}
