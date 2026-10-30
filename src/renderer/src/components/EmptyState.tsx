import { ArrowRight, ClipboardPaste, RotateCcw, SearchX, ShieldCheck } from 'lucide-react'
import { formatAccelerator } from '@shared/format'
import { useAppStore } from '../store'

export function EmptyState({ hasItems }: { hasItems: boolean }) {
  const openOnboarding = useAppStore((state) => state.openOnboarding)
  const query = useAppStore((state) => state.query)
  const setQuery = useAppStore((state) => state.setQuery)
  const typeFilter = useAppStore((state) => state.typeFilter)
  const setTypeFilter = useAppStore((state) => state.setTypeFilter)
  const onlyPinned = useAppStore((state) => state.onlyPinned)
  const onlyMissing = useAppStore((state) => state.onlyMissing)
  const toggleOnlyPinned = useAppStore((state) => state.toggleOnlyPinned)
  const toggleOnlyMissing = useAppStore((state) => state.toggleOnlyMissing)
  const captureHotkey = useAppStore(
    (state) => state.snapshot?.settings.hotkeyCapture ?? 'Control+Shift+D'
  )

  const addClipboard = async (): Promise<void> => {
    await window.flowtray.items.addClipboard()
  }

  const clearFilters = (): void => {
    setQuery('')
    setTypeFilter('all')
    if (onlyPinned) toggleOnlyPinned()
    if (onlyMissing) toggleOnlyMissing()
  }

  const filtered =
    Boolean(query.trim()) || onlyPinned || onlyMissing || typeFilter !== 'all'
  if (hasItems && filtered) {
    return (
      <div className="no-result" data-testid="no-results">
        <div className="no-result-icon">
          <SearchX size={21} strokeWidth={1.6} />
        </div>
        <div className="no-result-title">没有找到匹配的内容</div>
        <div className="no-result-copy">
          {query.trim() ? (
            <>
              没有与「{query.trim()}」匹配的卡片。
              <br />
              试试更短的关键词，或清除筛选条件。
            </>
          ) : (
            '当前筛选条件下没有卡片。'
          )}
        </div>
        <button type="button" className="btn btn-sm" onClick={clearFilters}>
          <RotateCcw size={12} />
          清除筛选
        </button>
      </div>
    )
  }

  return (
    <div className="empty-state" data-testid="empty-state">
      <EmptyArt />
      <h1 className="empty-title">把要用的东西，先停靠在这里</h1>
      <p className="empty-copy">
        从资源管理器、浏览器或聊天窗口拖进来。
        <br />
        或者按 <b>{formatAccelerator(captureHotkey)}</b> 存入剪贴板内容。
      </p>
      <div className="empty-actions">
        <button type="button" className="btn btn-primary" onClick={() => void addClipboard()}>
          <ClipboardPaste size={13} strokeWidth={1.9} />
          从剪贴板暂存
        </button>
        <button type="button" className="btn btn-ghost" onClick={openOnboarding}>
          怎么用
          <ArrowRight size={12} strokeWidth={1.9} />
        </button>
      </div>
      <div className="empty-privacy">
        <ShieldCheck size={11} strokeWidth={1.9} />
        只存本地 · 不上传 · 到期自动清理
      </div>
    </div>
  )
}

function EmptyArt() {
  return (
    <svg
      className="empty-art"
      width="164"
      height="128"
      viewBox="0 0 164 128"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="empty-card" x1="54" y1="28" x2="112" y2="76" gradientUnits="userSpaceOnUse">
          <stop stopColor="#D8FF5C" stopOpacity="0.34" />
          <stop offset="1" stopColor="#D8FF5C" stopOpacity="0.1" />
        </linearGradient>
      </defs>
      <g opacity="0.8">
        <rect
          x="25"
          y="16"
          width="50"
          height="36"
          rx="8"
          transform="rotate(-8 25 16)"
          fill="currentColor"
          fillOpacity="0.06"
          stroke="currentColor"
          strokeOpacity="0.3"
        />
        <circle cx="37" cy="29" r="3.2" fill="#D8FF5C" fillOpacity="0.8" />
        <rect x="44" y="26" width="19" height="2" rx="1" fill="currentColor" fillOpacity="0.32" />
        <rect x="44" y="32" width="13" height="2" rx="1" fill="currentColor" fillOpacity="0.22" />
      </g>
      <g className="empty-float">
        <rect
          x="62"
          y="24"
          width="60"
          height="43"
          rx="9"
          fill="url(#empty-card)"
          stroke="#D8FF5C"
          strokeOpacity="0.8"
        />
        <circle cx="76" cy="38" r="4.8" fill="#D8FF5C" fillOpacity="0.95" />
        <rect x="86" y="35" width="25" height="2.5" rx="1.25" fill="currentColor" fillOpacity="0.8" />
        <rect x="86" y="42" width="17" height="2" rx="1" fill="currentColor" fillOpacity="0.48" />
        <path d="M74 53h35" stroke="#D8FF5C" strokeOpacity="0.55" strokeLinecap="round" />
      </g>
      <path
        d="M88 76v12"
        stroke="#D8FF5C"
        strokeOpacity="0.75"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="2 4"
      />
      <path
        d="M82 85l6 6 6-6"
        stroke="#D8FF5C"
        strokeOpacity="0.85"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M44 95v9c0 5.5 4.5 10 10 10h54c5.5 0 10-4.5 10-10v-9"
        stroke="currentColor"
        strokeOpacity="0.6"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M48 103h66" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1" />
      <circle cx="139" cy="80" r="2" fill="#D8FF5C" fillOpacity="0.6" />
      <circle cx="23" cy="78" r="1.5" fill="currentColor" fillOpacity="0.3" />
    </svg>
  )
}
