import type { StemOption } from './types'

const STEM_KIND_PREFIX = 'stem:'
const EXPORT_STEM_WAV_PREFIX = 'stem-wav:'
const EXPORT_STEM_MP3_PREFIX = 'stem-mp3:'

type CanonicalStem = {
  name: string
  label: string
  displayOrder: number
  color: string
}

// Mirrors backend/core/stems.py CANONICAL_STEMS. Kept in sync by convention:
// when a new canonical role is added on the backend, add it here too so the
// UI can label, order, and color it without waiting on the API.
const CANONICAL_STEMS: readonly CanonicalStem[] = [
  { name: 'instrumental', label: 'Instrumental', displayOrder: 0, color: '#2f8f7f' },
  { name: 'vocals', label: 'Vocals', displayOrder: 1, color: '#c24a47' },
  { name: 'lead_vocals', label: 'Lead vocals', displayOrder: 2, color: '#c24a47' },
  { name: 'backing_vocals', label: 'Backing vocals', displayOrder: 3, color: '#d08a3f' },
  { name: 'drums', label: 'Drums', displayOrder: 4, color: '#b97012' },
  { name: 'bass', label: 'Bass', displayOrder: 5, color: '#7a5bb5' },
  { name: 'other', label: 'Other', displayOrder: 6, color: '#4f7a9a' },
  { name: 'piano', label: 'Piano', displayOrder: 7, color: '#4c8fbf' },
  { name: 'guitar', label: 'Guitar', displayOrder: 8, color: '#6b9c4f' },
]

const FALLBACK_COLOR = '#7a7f80'

const BY_NAME = new Map(CANONICAL_STEMS.map((stem) => [stem.name, stem] as const))

export function isStemKind(kind: string): boolean {
  return kind.startsWith(STEM_KIND_PREFIX)
}

function stemNameFromKind(kind: string): string | null {
  if (!kind.startsWith(STEM_KIND_PREFIX)) return null
  return kind.slice(STEM_KIND_PREFIX.length)
}

export function stemLabel(stemName: string): string {
  const canonical = BY_NAME.get(stemName)
  if (canonical) return canonical.label
  return stemName
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

export function stemSelectionLabel(stems: string[], stemOptions: StemOption[]) {
  const labels = new Map(stemOptions.map((option) => [option.name, option.label]))
  return stems.map((stem) => labels.get(stem) ?? stem).join(' + ')
}

function stemDisplayOrder(stemName: string): number {
  const canonical = BY_NAME.get(stemName)
  if (canonical) return canonical.displayOrder
  let sum = 0
  for (let i = 0; i < stemName.length; i += 1) sum += stemName.charCodeAt(i)
  return 1000 + (sum % 1000)
}

export function sortStemNames(stems: readonly string[]): string[] {
  return [...new Set(stems)].sort((a, b) => {
    const orderA = stemDisplayOrder(a)
    const orderB = stemDisplayOrder(b)
    if (orderA !== orderB) return orderA - orderB
    return a.localeCompare(b)
  })
}

export function compareStemKinds(a: string, b: string): number {
  const nameA = stemNameFromKind(a)
  const nameB = stemNameFromKind(b)
  if (nameA === null || nameB === null) {
    if (nameA === null && nameB === null) return a.localeCompare(b)
    return nameA === null ? 1 : -1
  }
  const orderA = stemDisplayOrder(nameA)
  const orderB = stemDisplayOrder(nameB)
  if (orderA !== orderB) return orderA - orderB
  return nameA.localeCompare(nameB)
}

export function exportStemKind(stemName: string, fmt: 'wav' | 'mp3'): string {
  return `${fmt === 'wav' ? EXPORT_STEM_WAV_PREFIX : EXPORT_STEM_MP3_PREFIX}${stemName}`
}

function stemColor(stemName: string | null | undefined): string {
  if (!stemName) return FALLBACK_COLOR
  return BY_NAME.get(stemName)?.color ?? FALLBACK_COLOR
}

export function stemColorFromKind(kind: string): string {
  return stemColor(stemNameFromKind(kind))
}
