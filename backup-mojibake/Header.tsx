import { useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  ClipboardPlus,
  Settings2
} from 'lucide-react'
import { formatAccelerator } from '@shared/format'
import { useAppStore } from '../store'
import { BrandMark } from './ui'

export function Header() {
  const snapshot = useAppStore((state) => state.snapshot)
  const openSettings = useAppStore((state) => state.openSettings)
  const [adding, setAdding] = useState(false)
  const settings = snapshot?.settings
  const items = snapshot?.items ?? []
  const count = items.length
  const side = settings?.shelfSide ?? 'right'
  const hotkey = settings?.hotkeyToggle ?? 'Control+Alt+Space'

  const addClipboard = async (): Promise<void> => {
    if (adding) return
    setAdding(true)
    try {
      await window.flowtray.items.addClipboard()
    } finally {
      setAdding(false)
    }
  }

  return (
    <header className="topbar" data-testid="header">
      <div className="brand">
        <BrandMark size={30} />
        <div className="brand-text">
          <div className="brand-line">
            <span className="brand-name">FlowTray</span>
            <span className="brand-cn">娴佽浆鍙?/span>
            <span className={`count-pill ${count === 0 ? 'is-zero' : ''}`}>{count}</span>
          </div>
          <div className="brand-meta">
            <span className="tag-dot" />
            {settings?.clipboardMonitor ? '鍓创鏉跨洃鍚腑' : '涓存椂涓浆 路 鏈湴浼樺厛'}
          </div>
        </div>
      </div>

      <div className="topbar-actions">
        <button
          type="button"
          className="icon-button"
          title={`浠庡壀璐存澘鏆傚瓨锛?{formatAccelerator(settings?.hotkeyCapture ?? 'Control+Shift+D')}锛塦}
          aria-label="浠庡壀璐存澘鏆傚瓨"
          data-testid="add-clipboard"
          onClick={() => void addClipboard()}
          disabled={adding}
        >
          {adding ? <span className="spinner" style={{ width: 13, height: 13 }} /> : <ClipboardPlus size={15} strokeWidth={1.8} />}
        </button>
        <span className="topbar-divider" />
        <button
          type="button"
          className="icon-button"
          title="璁剧疆"
          aria-label="璁剧疆"
          data-testid="open-settings"
          onClick={() => openSettings('general')}
        >
          <Settings2 size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={`闅愯棌娴佽浆鍙帮紙${formatAccelerator(hotkey)}锛塦}
          aria-label="闅愯棌娴佽浆鍙?
          data-testid="hide-shelf"
          onClick={() => void window.flowtray.app.hideWindow()}
        >
          {side === 'right' ? (
            <ChevronRight size={16} strokeWidth={1.9} />
          ) : (
            <ChevronLeft size={16} strokeWidth={1.9} />
          )}
        </button>
      </div>
    </header>
  )
}

