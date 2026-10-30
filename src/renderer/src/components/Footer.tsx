import { HardDrive, ShieldCheck, Trash2 } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { useAppStore } from '../store'

export function Footer() {
  const snapshot = useAppStore((state) => state.snapshot)
  const openSettings = useAppStore((state) => state.openSettings)
  const setConfirm = useAppStore((state) => state.setConfirm)
  if (!snapshot) return null
  const { usage, settings } = snapshot
  const capacity = usage.capacityBytes
  const percent = capacity > 0 ? Math.min(100, (usage.storedBytes / capacity) * 100) : 0
  const high = percent >= 85
  const over = percent >= 100
  const listening = settings.clipboardMonitor

  let text: string
  if (usage.storedBytes === 0 && usage.referencedBytes > 0) {
    text = `引用 ${formatBytes(usage.referencedBytes)} · 不占空间`
  } else if (capacity === 0) {
    text = `${formatBytes(usage.storedBytes)} · 不限容量`
  } else {
    text = `${formatBytes(usage.storedBytes)} / ${formatBytes(capacity)}`
  }

  const title = [
    `已用存储 ${formatBytes(usage.storedBytes)}`,
    capacity > 0 ? `上限 ${formatBytes(capacity)}` : '容量不限',
    usage.referencedBytes > 0 ? `引用原文件 ${formatBytes(usage.referencedBytes)}（未复制）` : '',
    `${usage.itemCount} 项内容 · ${usage.pinnedCount} 项固定`
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <footer className="footer" data-testid="footer">
      <button
        type="button"
        className="storage-meter"
        title={title}
        onClick={() => openSettings('storage')}
      >
        <span className={`meter ${over ? 'is-over' : high ? 'is-high' : ''}`}>
          <i style={{ width: `${capacity === 0 ? 0 : Math.max(percent, usage.storedBytes > 0 ? 2 : 0)}%` }} />
        </span>
        <HardDrive size={10} strokeWidth={1.9} />
        <span className="storage-text">{text}</span>
      </button>
      <div className="footer-right">
        <button
          type="button"
          className="footer-action privacy"
          title="本地优先：所有内容只保存在这台电脑上。点击查看隐私设置。"
          onClick={() => openSettings('privacy')}
        >
          {listening ? <span className="listening-dot" /> : <ShieldCheck size={11} strokeWidth={1.9} />}
          本地
        </button>
        {usage.itemCount > 0 ? (
          <button
            type="button"
            className="footer-action clear"
            title="清空未固定项（可撤销）"
            data-testid="clear-button"
            onClick={() => setConfirm('clear-shelf')}
          >
            <Trash2 size={11} strokeWidth={1.9} />
            清空
          </button>
        ) : null}
      </div>
    </footer>
  )
}
