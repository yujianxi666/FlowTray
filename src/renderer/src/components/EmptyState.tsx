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
      width="150"
      height="118"
      viewBox="0 0 150 118"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="empty-card" x1="45" y1="27" x2="102" y2="72" gradientUnits="userSpaceOnUse">
          <stop stopColor="#D8FF5C" stopOpacity="0.22" />
          <stop offset="1" stopColor="#D8FF5C" stopOpacity="0.04" />
        </linearGradient>
      </defs>
      <g opacity="0.55">
        <rect
          x="23"
          y="15"
          width="48"
          height="34"
          rx="7"
          transform="rotate(-8 23 15)"
          fill="#F4F1E8"
          fillOpacity="0.05"
          stroke="#F4F1E8"
          strokeOpacity="0.16"
        />
        <circle cx="34" cy="27" r="3" fill="#D8FF5C" fillOpacity="0.7" />
        <rect x="41" y="24" width="18" height="2" rx="1" fill="#F4F1E8" fillOpacity="0.18" />
        <rect x="41" y="30" width="12" height="2" rx="1" fill="#F4F1E8" fillOpacity="0.12" />
      </g>
      <g className="empty-float">
        <rect
          x="58"
          y="24"
          width="56"
          height="40"
          rx="8"
          fill="url(#empty-card)"
          stroke="#D8FF5C"
          strokeOpacity="0.5"
        />
        <circle cx="71" cy="37" r="4.5" fill="#D8FF5C" fillOpacity="0.9" />
        <rect x="80" y="34" width="24" height="2.5" rx="1.25" fill="#F4F1E8" fillOpacity="0.65" />
        <rect x="80" y="41" width="16" height="2" rx="1" fill="#F4F1E8" fillOpacity="0.3" />
        <path d="M69 51h33" stroke="#D8FF5C" strokeOpacity="0.4" strokeLinecap="round" />
      </g>
      <path
        d="M81 71v12"
        stroke="#D8FF5C"
        strokeOpacity="0.6"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="2 4"
      />
      <path
        d="M76 79l5 5 5-5"
        stroke="#D8FF5C"
        strokeOpacity="0.7"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M40 88v10c0 5.5 4.5 10 10 10h50c5.5 0 10-4.5 10-10V88"
        stroke="#F4F1E8"
        strokeOpacity="0.34"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M44 96h62" stroke="#F4F1E8" strokeOpacity="0.1" strokeWidth="1" />
      <circle cx="127" cy="76" r="2" fill="#D8FF5C" fillOpacity="0.4" />
      <circle cx="22" cy="73" r="1.5" fill="#F4F1E8" fillOpacity="0.2" />
    </svg>
  )
}
