import { useEffect, useState } from 'react'
import { RotateCcw, Trash2, TriangleAlert, X } from 'lucide-react'
import { useAppStore } from '../store'
import { formatBytes } from '@shared/format'
import { Modal, Switch } from './ui'

export function ConfirmDialog() {
  const confirm = useAppStore((state) => state.confirm)
  const setConfirm = useAppStore((state) => state.setConfirm)
  const snapshot = useAppStore((state) => state.snapshot)
  const pushToast = useAppStore((state) => state.pushToast)
  const [includePinned, setIncludePinned] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setIncludePinned(false)
    setBusy(false)
  }, [confirm])

  useEffect(() => {
    if (!confirm) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        setConfirm(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, busy, setConfirm])

  if (!confirm || !snapshot) return null
  const items = snapshot.items
  const pinnedCount = items.filter((item) => item.pinned).length
  const unpinnedCount = items.length - pinnedCount
  const clearCount = includePinned ? items.length : unpinnedCount
  const close = (): void => {
    if (!busy) setConfirm(null)
  }

  const clearShelf = async (): Promise<void> => {
    if (clearCount === 0) {
      setConfirm(null)
      pushToast('没有可清理的内容。', 'info')
      return
    }
    setBusy(true)
    const result = await window.flowtray.items.clear({ includePinned })
    setBusy(false)
    setConfirm(null)
    if (result.ok) {
      pushToast(
        includePinned
          ? `已清空 ${clearCount} 项内容，可在下方撤销。`
          : `已清空 ${clearCount} 项临时内容，固定项已保留。`,
        'info'
      )
    } else {
      pushToast(result.message ?? '清空失败。', 'error')
    }
  }

  const clearData = async (withSettings: boolean): Promise<void> => {
    setBusy(true)
    const result = await window.flowtray.settings.clearAllData(withSettings)
    setBusy(false)
    if (result.ok) {
      setConfirm(null)
      pushToast(result.message ?? '本地数据已清除。', 'success')
    } else {
      pushToast(result.message ?? '清除失败。', 'error')
    }
  }

  const resetSettings = async (): Promise<void> => {
    setBusy(true)
    const result = await window.flowtray.settings.reset()
    setBusy(false)
    setConfirm(null)
    if (result.ok) pushToast('已恢复默认设置。', 'success')
    else pushToast(result.errors[0]?.message ?? '恢复默认设置失败。', 'error')
  }

  if (confirm === 'clear-shelf') {
    return (
      <Modal onClose={close} labelledBy="confirm-title">
        <div className="confirm-top">
          <div className="confirm-badge is-warning">
            <Trash2 size={17} strokeWidth={1.8} />
          </div>
          <button type="button" className="icon-button confirm-close" onClick={close} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <h2 className="confirm-title" id="confirm-title">
          清空暂存台？
        </h2>
        <p className="confirm-copy">
          {clearCount > 0
            ? `将移除 ${clearCount} 项内容。此操作可在 30 秒内撤销。`
            : '当前没有可清理的临时项。'}
        </p>
        {pinnedCount > 0 ? (
          <div className="confirm-option">
            <div>
              <div className="confirm-option-label">同时移除已固定内容</div>
              <div className="confirm-option-hint">默认保留 {pinnedCount} 项已固定的重要内容</div>
            </div>
            <Switch
              checked={includePinned}
              onChange={setIncludePinned}
              label="同时移除已固定内容"
            />
          </div>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void clearShelf()}
            disabled={busy || clearCount === 0}
          >
            {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
            清空 {clearCount > 0 ? clearCount : ''} 项
          </button>
        </div>
      </Modal>
    )
  }

  if (confirm === 'clear-data' || confirm === 'reset-data') {
    const withSettings = confirm === 'reset-data'
    return (
      <Modal onClose={close} labelledBy="confirm-title">
        <div className="confirm-top">
          <div className="confirm-badge is-danger">
            <TriangleAlert size={17} strokeWidth={1.8} />
          </div>
          <button type="button" className="icon-button confirm-close" onClick={close} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <h2 className="confirm-title" id="confirm-title">
          {withSettings ? '重置全部本地数据？' : '清除所有暂存内容？'}
        </h2>
        <p className="confirm-copy">
          将删除 {items.length} 项暂存记录、FlowTray 保存的文件副本与缩略图
          {snapshot.usage.storedBytes > 0
            ? `（约 ${formatBytes(snapshot.usage.storedBytes)}）`
            : ''}
          。
          {withSettings
            ? '同时重置设置、快捷键与日志，并重新显示新手引导。应用会重新启动。'
            : '你的设置会保留，应用会重新启动。'}
          <br />
          <strong>此操作不可撤销。</strong>原始文件不会被删除。
        </p>
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void clearData(withSettings)}
            disabled={busy}
          >
            {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
            {withSettings ? '重置全部数据' : '清除暂存内容'}
          </button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal onClose={close} labelledBy="confirm-title">
      <div className="confirm-top">
        <div className="confirm-badge">
          <RotateCcw size={17} strokeWidth={1.8} />
        </div>
        <button type="button" className="icon-button confirm-close" onClick={close} aria-label="关闭">
          <X size={14} />
        </button>
      </div>
      <h2 className="confirm-title" id="confirm-title">
        恢复默认设置？
      </h2>
      <p className="confirm-copy">
        过期时间、拖拽方式、外观与快捷键会恢复默认。暂存内容和固定的卡片不会被删除，
        自定义存储位置也会保留。
      </p>
      <div className="confirm-actions">
        <button type="button" className="btn" onClick={close} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void resetSettings()}
          disabled={busy}
        >
          {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
          恢复默认
        </button>
      </div>
    </Modal>
  )
}
