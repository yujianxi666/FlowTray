import { Copy, FolderSearch, Pin, PinOff, Trash2, X } from 'lucide-react'
import type { ShelfItemView } from '@shared/types'
import { useAppStore } from '../store'

export function SelectionBar({
  selection,
  allPinned
}: {
  selection: ShelfItemView[]
  allPinned: boolean
}) {
  const clearSelection = useAppStore((state) => state.clearSelection)
  const pushToast = useAppStore((state) => state.pushToast)
  const snapshot = useAppStore((state) => state.snapshot)
  const ids = selection.map((item) => item.id)

  if (selection.length === 0 || !snapshot) return null

  const copy = async (kind: 'auto' | 'path'): Promise<void> => {
    const result = await window.flowtray.items.copy(ids, kind)
    if (result.ok) pushToast(result.message ?? '已复制。', 'success')
    else pushToast(result.message ?? '复制失败。', 'error')
  }

  const pin = async (): Promise<void> => {
    const result = await window.flowtray.items.pin(ids, !allPinned)
    if (result.ok) {
      pushToast(
        !allPinned ? `已固定 ${selection.length} 项` : `已取消固定 ${selection.length} 项`,
        'success'
      )
    }
  }

  const remove = async (): Promise<void> => {
    const result = await window.flowtray.items.remove(ids)
    if (result.ok) {
      clearSelection()
      pushToast(`已删除 ${selection.length} 项，可在下方撤销。`, 'info')
    }
  }

  const relocate = async (): Promise<void> => {
    const missing = selection.find((item) => item.status === 'missing')
    if (!missing) return
    const result = await window.flowtray.items.relocate(missing.id)
    if (result.ok) pushToast('已重新定位。', 'success')
    else if (result.errors[0] && result.errors[0].code !== 'invalid') {
      pushToast(result.errors[0].message, 'error')
    }
  }

  const hasMissing = selection.some((item) => item.status === 'missing')

  return (
    <div className="selection-bar" data-testid="selection-bar">
      <div className="selection-count">
        <strong>
          已选 <em>{selection.length}</em> 项
        </strong>
        <span>拖动已选卡片可批量拖出</span>
      </div>
      <div className="selection-actions">
        <button
          type="button"
          className="selection-action"
          onClick={() => void copy('auto')}
          title="复制文件 / 文本 / 图片"
        >
          <Copy size={14} strokeWidth={1.8} />
          复制
        </button>
        <button
          type="button"
          className="selection-action"
          onClick={() => void copy('path')}
          title="批量复制路径或文本"
        >
          <FolderSearch size={14} strokeWidth={1.8} />
          路径
        </button>
        {hasMissing ? (
          <button
            type="button"
            className="selection-action"
            onClick={() => void relocate()}
            title="重新定位失效文件"
          >
            <FolderSearch size={14} strokeWidth={1.8} />
            定位
          </button>
        ) : (
          <button
            type="button"
            className="selection-action"
            onClick={() => void pin()}
            title={allPinned ? '取消固定' : '固定所选'}
          >
            {allPinned ? <PinOff size={14} strokeWidth={1.8} /> : <Pin size={14} strokeWidth={1.8} />}
            {allPinned ? '取消固定' : '固定'}
          </button>
        )}
        <button
          type="button"
          className="selection-action is-danger"
          onClick={() => void remove()}
          title="删除所选（可撤销）"
        >
          <Trash2 size={14} strokeWidth={1.8} />
          删除
        </button>
        <button
          type="button"
          className="selection-action"
          onClick={clearSelection}
          title="取消选择"
        >
          <X size={14} strokeWidth={1.8} />
          取消选择
        </button>
      </div>
    </div>
  )
}
