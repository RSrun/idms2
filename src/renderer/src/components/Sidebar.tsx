import type { CategoryId } from '@shared/types'
import { useT } from '../i18n'

interface Props {
  category: CategoryId | 'all'
  counts: Record<string, number>
  onSelect: (c: CategoryId | 'all') => void
}

interface CatDef {
  id: CategoryId | 'all'
  icon: string
  labelKey: Parameters<ReturnType<typeof useT>>[0]
}

const GROUPS: Array<{ section?: string; items: CatDef[] }> = [
  {
    items: [
      { id: 'all', icon: '☰', labelKey: 'common.all' },
      { id: 'downloading', icon: '⬇', labelKey: 'cat.downloading' },
      { id: 'queued', icon: '⋯', labelKey: 'cat.queued' },
      { id: 'completed', icon: '✓', labelKey: 'cat.completed' },
      { id: 'paused', icon: '⏸', labelKey: 'cat.paused' },
      { id: 'scheduled', icon: '⏰', labelKey: 'cat.scheduled' },
      { id: 'error', icon: '⚠', labelKey: 'cat.error' }
    ]
  },
  {
    section: 'TUR',
    items: [
      { id: 'video', icon: '🎬', labelKey: 'cat.video' },
      { id: 'audio', icon: '🎵', labelKey: 'cat.audio' },
      { id: 'archive', icon: '🗜', labelKey: 'cat.archive' },
      { id: 'program', icon: '💾', labelKey: 'cat.program' },
      { id: 'document', icon: '📄', labelKey: 'cat.document' },
      { id: 'other', icon: '📦', labelKey: 'cat.other' }
    ]
  }
]

export function Sidebar({ category, counts, onSelect }: Props) {
  const t = useT()
  return (
    <aside className="sidebar">
      {GROUPS.map((g, gi) => (
        <div key={gi}>
          {g.section && <div className="section">{t('col.type')}</div>}
          {g.items.map((c) => (
            <button
              key={c.id}
              className={`cat ${category === c.id ? 'active' : ''}`}
              onClick={() => onSelect(c.id)}
            >
              <span className="cico">{c.icon}</span>
              <span>{t(c.labelKey)}</span>
              {counts[c.id] ? <span className="count">{counts[c.id]}</span> : null}
            </button>
          ))}
        </div>
      ))}
    </aside>
  )
}
