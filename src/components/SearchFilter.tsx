import type { RefObject } from 'react'
import {
  LayoutGrid,
  List,
  Pin,
  Search,
  TriangleAlert,
  X
} from 'lucide-react'
import type { Settings } from '@shared/settings'
import { useAppStore } from '../store'

export interface Counts {
  all: number
  file: number
  image: number
  text: number
  url: number
  pinned: number
  missing: number
  clipboard: number
}

const TYPE_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'file', label: '文件' },
  { value: 'image', label: '图片' },
  { value: 'text', label: '文本' },
  { value: 'url', label: '链接' },
  { value: 'clipboard', label: '剪贴板' }
] as const

export function SearchFilter({
  searchRef,
  counts
}: {
  searchRef: RefObject<HTMLInputElement | null>
  counts: Counts
}) {
  const query = useAppStore((state) => state.query)
  const setQuery = useAppStore((state) => state.setQuery)
  const typeFilter = useAppStore((state) => state.typeFilter)
  const setTypeFilter = useAppStore((state) => state.setTypeFilter)
  const onlyPinned = useAppStore((state) => state.onlyPinned)
  const toggleOnlyPinned = useAppStore((state) => state.toggleOnlyPinned)
  const onlyMissing = useAppStore((state) => state.onlyMissing)
  const toggleOnlyMissing = useAppStore((state) => state.toggleOnlyMissing)
  const snapshot = useAppStore((state) => state.snapshot)
  const settings = snapshot?.settings as Settings | undefined
  const viewMode = settings?.viewMode ?? 'list'

  const changeView = (mode: 'list' | 'grid'): void => {
    if (mode === viewMode) return
    void window.flowtray.settings.update({ viewMode: mode })
  }

  return (
    <div className="toolbar">
      <div className="search-row">
        <label className="search-field">
          <Search size={13} strokeWidth={1.8} />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、内容、链接…"
            spellCheck={false}
            aria-label="搜索暂存内容"
            data-testid="search-input"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                if (query) setQuery('')
                else event.currentTarget.blur()
                event.stopPropagation()
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="search-clear"
              aria-label="清除搜索"
              onClick={() => setQuery('')}
            >
              <X size={12} strokeWidth={2} />
            </button>
          ) : (
            <span className="search-kbd">/</span>
          )}
        </label>
        <div className="view-toggle" role="group" aria-label="视图">
          <button
            type="button"
            className={`icon-button ${viewMode === 'list' ? 'is-active' : ''}`}
            title="列表视图"
            aria-label="列表视图"
            aria-pressed={viewMode === 'list'}
            data-testid="view-list"
            onClick={() => changeView('list')}
          >
            <List size={14} strokeWidth={1.9} />
          </button>
          <button
            type="button"
            className={`icon-button ${viewMode === 'grid' ? 'is-active' : ''}`}
            title="网格视图"
            aria-label="网格视图"
            aria-pressed={viewMode === 'grid'}
            data-testid="view-grid"
            onClick={() => changeView('grid')}
          >
            <LayoutGrid size={14} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <div className="filter-row" role="group" aria-label="类型筛选">
        {TYPE_FILTERS.filter(
          (filter) => filter.value !== 'clipboard' || counts.clipboard > 0
        ).map((filter) => (
          <button
            key={filter.value}
            type="button"
            className={`filter-chip ${typeFilter === filter.value ? 'is-active' : ''}`}
            aria-pressed={typeFilter === filter.value}
            data-testid={`filter-${filter.value}`}
            onClick={() => setTypeFilter(filter.value)}
          >
            {filter.label}
            <span className="chip-count">{counts[filter.value]}</span>
          </button>
        ))}
        <span className="filter-sep" />
        <button
          type="button"
          className={`filter-chip filter-pin ${onlyPinned ? 'is-active' : ''}`}
          aria-pressed={onlyPinned}
          title="只看固定项"
          onClick={toggleOnlyPinned}
        >
          <Pin size={10} strokeWidth={2} />
          固定
          <span className="chip-count">{counts.pinned}</span>
        </button>
        {counts.missing > 0 ? (
          <button
            type="button"
            className={`filter-chip filter-missing ${onlyMissing ? 'is-active' : ''}`}
            aria-pressed={onlyMissing}
            title="只看失效项"
            onClick={toggleOnlyMissing}
          >
            <TriangleAlert size={10} strokeWidth={2} />
            失效
            <span className="chip-count">{counts.missing}</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

