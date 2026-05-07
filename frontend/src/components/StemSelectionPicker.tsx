import type { QualityOption, RunProcessingConfigInput, StemOption, StemQuality } from '../types'
import { sortStemNames } from '../stems'

const BAND_STEMS = new Set(['drums', 'bass', 'other'])
const VOCAL_ROUTE_STEMS = new Set(['vocals', 'instrumental', 'lead_vocals', 'backing_vocals'])
const VOCAL_GROUP_STEMS = new Set(['instrumental', 'vocals', 'lead_vocals', 'backing_vocals'])

type StemPreset = {
  label: string
  description: string
  title: string
  stems: string[]
}

type StemSelectionPickerProps = {
  value: RunProcessingConfigInput
  stemOptions: StemOption[]
  qualityOptions: QualityOption[]
  disabled?: boolean
  compact?: boolean
  onChange: (next: RunProcessingConfigInput) => void
}

export function StemSelectionPicker({
  value,
  stemOptions,
  qualityOptions,
  disabled = false,
  compact = false,
  onChange,
}: StemSelectionPickerProps) {
  const selected = new Set(value.stems)
  const usesVocalQualityRoute = usesQualityRoute(value.stems)
  const visibleQualityOptions = usesVocalQualityRoute ? qualityOptions : []
  const vocalOptions = stemOptions.filter((option) => VOCAL_GROUP_STEMS.has(option.name))
  const bandOptions = stemOptions.filter((option) => BAND_STEMS.has(option.name))
  const otherOptions = stemOptions.filter(
    (option) => !VOCAL_GROUP_STEMS.has(option.name) && !BAND_STEMS.has(option.name),
  )
  const available = new Set(stemOptions.map((option) => option.name))
  const presets = buildStemPresets(available)

  function toggleStem(name: string) {
    const next = new Set(selected)
    if (next.has(name)) {
      if (next.size === 1) return
      next.delete(name)
    } else {
      next.add(name)
      if (name === 'instrumental') {
        BAND_STEMS.forEach((stem) => next.delete(stem))
      } else if (BAND_STEMS.has(name)) {
        next.delete('instrumental')
      }
    }
    const stems = sortStemNames(stemOptions.map((option) => option.name).filter((name) => next.has(name)))
    onChange({ ...value, stems, quality: usesQualityRoute(stems) ? value.quality : 'balanced' })
  }

  function applyPreset(stems: string[]) {
    const nextStems = sortStemNames(stems.filter((stem) => available.has(stem)))
    onChange({ ...value, stems: nextStems, quality: usesQualityRoute(nextStems) ? value.quality : 'balanced' })
  }

  function setQuality(quality: StemQuality) {
    onChange({ ...value, quality })
  }

  const qualityControl = visibleQualityOptions.length > 1 ? (
    <div className="stem-quality" role="group" aria-label="Separation quality">
      {visibleQualityOptions.map((option) => (
        <button
          key={option.key}
          type="button"
          className={`segmented ${value.quality === option.key ? 'segmented-active' : ''}`}
          disabled={disabled}
          onClick={() => setQuality(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ) : null

  return (
    <div className={`stem-selection-picker ${compact ? 'stem-selection-picker-compact' : ''}`}>
      {presets.length > 0 ? (
        <div className={`stem-preset-row ${compact ? 'stem-preset-row-compact' : ''}`} role="group" aria-label="Separation goals">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={`stem-preset ${sameStemSet(value.stems, preset.stems) ? 'is-selected' : ''}`}
              disabled={disabled}
              onClick={() => applyPreset(preset.stems)}
              title={preset.title}
            >
              <strong>{preset.label}</strong>
              <span>{preset.description}</span>
            </button>
          ))}
        </div>
      ) : null}

      <details className="stem-manual" open={presets.length === 0 || undefined}>
        <summary>
          <span>{compact ? 'Customize' : 'Manual stems'}</span>
          <strong>{stemSelectionSummary(value.stems, stemOptions)}</strong>
        </summary>
        <div className="stem-picker-groups">
          {vocalOptions.length > 0 ? (
            <StemOptionGroup
              title="Vocals"
              options={vocalOptions}
              selected={selected}
              disabled={disabled}
              onToggle={toggleStem}
            />
          ) : null}
          {bandOptions.length > 0 ? (
            <StemOptionGroup
              title="Core instruments"
              hint={selected.has('instrumental') ? 'Choosing an instrument replaces the combined instrumental stem.' : null}
              options={bandOptions}
              selected={selected}
              disabled={disabled}
              onToggle={toggleStem}
            />
          ) : null}
          {otherOptions.length > 0 ? (
            <StemOptionGroup
              title="More instruments"
              options={otherOptions}
              selected={selected}
              disabled={disabled}
              onToggle={toggleStem}
              />
            ) : null}
          {compact ? qualityControl : null}
        </div>
      </details>

      {compact ? null : qualityControl}
    </div>
  )
}

function StemOptionGroup({
  title,
  hint,
  options,
  selected,
  disabled,
  onToggle,
}: {
  title: string
  hint?: string | null
  options: StemOption[]
  selected: Set<string>
  disabled: boolean
  onToggle: (name: string) => void
}) {
  return (
    <div className="stem-option-group">
      <div className="stem-option-group-head">
        <strong>{title}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      <div className="stem-checklist" role="group" aria-label={title}>
        {options.map((option) => {
          const checked = selected.has(option.name)
          return (
            <label key={option.name} className={`stem-check ${checked ? 'is-selected' : ''}`}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => onToggle(option.name)}
              />
              <span>{option.label}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

function usesQualityRoute(stems: string[]) {
  return stems.some((stem) => VOCAL_ROUTE_STEMS.has(stem))
}

function hasAll(available: Set<string>, stems: string[]) {
  return stems.every((stem) => available.has(stem))
}

function sameStemSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false
  const right = new Set(b)
  return a.every((stem) => right.has(stem))
}

function buildStemPresets(available: Set<string>): StemPreset[] {
  const presets: StemPreset[] = []

  if (hasAll(available, ['instrumental', 'vocals'])) {
    presets.push({
      label: 'Karaoke',
      description: 'Instrumental and vocals',
      title: 'Create a stem set for muting vocals, making instrumentals, or exporting vocals alone.',
      stems: ['instrumental', 'vocals'],
    })
  }

  if (hasAll(available, ['instrumental', 'lead_vocals', 'backing_vocals'])) {
    presets.push({
      label: 'Keep backing vocals',
      description: 'Lead separated from backing',
      title: 'Separate lead and backing vocals so backing vocals can stay in the mix.',
      stems: ['instrumental', 'lead_vocals', 'backing_vocals'],
    })
  }

  if (hasAll(available, ['vocals', 'drums', 'bass', 'other'])) {
    presets.push({
      label: 'Full remix',
      description: 'Vocals, drums, bass, instruments',
      title: 'Create editable band stems for deeper remixing.',
      stems: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'].filter((stem) => available.has(stem)),
    })
  }

  return presets
}

function stemSelectionSummary(stems: string[], options: StemOption[]) {
  if (stems.length === 0) return 'No stems selected'
  const labels = stems.map((stem) => options.find((option) => option.name === stem)?.label ?? stem)
  if (labels.length <= 3) return labels.join(', ')
  return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more`
}
