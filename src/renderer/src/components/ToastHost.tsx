import {
  AlertCircle,
  CheckCircle2,
  Info,
  Undo2,
  X
} from 'lucide-react'
import { useAppStore } from '../store'

export function ToastHost() {
  const toasts = useAppStore((state) => state.toasts)
  const dismissToast = useAppStore((state) => state.dismissToast)
  const snapshot = useAppStore((state) => state.snapshot)
  const undoDismissedAt = useAppStore((state) => state.undoDismissedAt)
  const dismissUndo = useAppStore((state) => state.dismissUndo)
  const pushToast = useAppStore((state) => state.pushToast)
  const selection = useAppStore((state) => state.selection)
  const busy = useAppStore((state) => state.dropBusyLabel)
  const undo = snapshot?.undo ?? null
  const visibleUndo = undo && undoDismissedAt !== undo.expiresAt ? undo : null
  const remaining = undo ? Math.max(0, undo.expiresAt - Date.now()) : 0

  const restore = async (): Promise<void> => {
    const result = await window.flowtray.items.restoreUndo()
    if (result.ok) {
      pushToast(`已恢复 ${result.added} 项内容。`, 'success')
    } else {
      pushToast(result.errors[0]?.message ?? '撤销失败。', 'error')
    }
  }

  return (
    <div
      className="toast-host"
      aria-live="polite"
      style={{ bottom: selection.length > 0 ? 66 : 50, opacity: busy ? 0.35 : 1 }}
      data-testid="toast-host"
    >
      {toasts.map((toast) => {
        const Icon =
          toast.tone === 'success'
            ? CheckCircle2
            : toast.tone === 'error'
              ? AlertCircle
              : Info
        return (
          <div key={toast.id} className={`toast is-${toast.tone}`} data-testid="toast">
            <span className="toast-icon">
              <Icon size={13} strokeWidth={1.9} />
            </span>
            <span className="toast-message">{toast.message}</span>
            <button
              type="button"
              className="icon-button"
              style={{ width: 18, height: 18 }}
              aria-label="关闭提示"
              onClick={() => dismissToast(toast.id)}
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
      {visibleUndo ? (
        <div
          key={undo?.expiresAt}
          className="toast undo-toast"
          data-testid="undo-toast"
          role="status"
        >
          <span className="toast-icon undo-icon">
            <Undo2 size={13} strokeWidth={1.9} />
          </span>
          <span className="toast-message">
            {visibleUndo.label}，可在 {Math.ceil(remaining / 1000)} 秒内撤销
          </span>
          <button type="button" className="toast-action" onClick={() => void restore()}>
            撤销
          </button>
          <button
            type="button"
            className="icon-button"
            style={{ width: 18, height: 18, alignSelf: 'center' }}
            aria-label="隐藏撤销提示"
            onClick={dismissUndo}
          >
            <X size={11} />
          </button>
          <span
            className="undo-progress"
            style={{ animationDuration: `${Math.max(600, remaining)}ms` }}
          />
        </div>
      ) : null}
    </div>
  )
}
