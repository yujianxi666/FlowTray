import { ArrowDownToLine, File, Folder, Image, Link2, Type } from 'lucide-react'
import { DRAG_MODIFIER_LABEL } from '@shared/constants'
import { useAppStore } from '../store'

const TYPES = [
  { icon: File, label: '文件' },
  { icon: Folder, label: '文件夹' },
  { icon: Image, label: '图片' },
  { icon: Type, label: '文本' },
  { icon: Link2, label: '链接' }
]

export function DropOverlay() {
  const active = useAppStore((state) => state.dropActive)
  const busyLabel = useAppStore((state) => state.dropBusyLabel)
  const effect = useAppStore((state) => state.dropEffect)
  const settings = useAppStore((state) => state.snapshot?.settings)
  if (!active && !busyLabel) return null

  const modifier = DRAG_MODIFIER_LABEL[settings?.dragModifier ?? 'ctrl']
  const busy = Boolean(busyLabel)

  return (
    <div
      className={`drop-overlay ${busy ? 'is-busy' : ''}`}
      data-testid="drop-overlay"
    >
      <div className="drop-inner">
        <div className="drop-icon">
          {busy ? <span className="spinner" style={{ borderTopColor: '#151B0A', width: 24, height: 24 }} /> : <ArrowDownToLine size={26} strokeWidth={2} />}
        </div>
        <div className="drop-title">{busy ? '正在接收…' : '松手，放进流转台'}</div>
        <div className="drop-subtitle">
          {busy
            ? busyLabel
            : '文件默认只记录路径，不改动原文件；图片、文本和链接会存到本地。'}
        </div>
        {!busy ? (
          <>
            <div className="drop-types">
              {TYPES.map(({ icon: Icon, label }) => (
                <span key={label} className="drop-type">
                  <Icon size={9} strokeWidth={1.9} />
                  {label}
                </span>
              ))}
            </div>
            <div className={`drop-effect ${effect === 'cut' ? 'is-cut' : ''}`}>
              {effect === 'cut' ? '剪切暂存' : '复制暂存'}
              <span style={{ opacity: 0.6 }}>·</span>
              按住 {modifier} 临时切换
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
