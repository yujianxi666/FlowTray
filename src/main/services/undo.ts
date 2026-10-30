import type { UndoKind, UndoState } from '@shared/types'
import { UNDO_WINDOW_MS } from '@shared/constants'

interface UndoEntry {
  kind: UndoKind
  ids: string[]
  state: UndoState
}

const LABELS: Record<UndoKind, string> = {
  clear: '已清空',
  delete: '已删除',
  expiry: '到期清理'
}

export class UndoManager {
  private entry: UndoEntry | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: () => void) {}

  set(kind: UndoKind, ids: string[], now = Date.now()): UndoState {
    this.clearTimer()
    const windowMs = UNDO_WINDOW_MS[kind]
    const state: UndoState = {
      kind,
      count: ids.length,
      expiresAt: now + windowMs,
      label: `${LABELS[kind]} ${ids.length} 项`
    }
    this.entry = { kind, ids: [...ids], state }
    this.timer = setTimeout(() => {
      this.entry = null
      this.timer = null
      this.onChange()
    }, windowMs)
    this.onChange()
    return state
  }

  getState(now = Date.now()): UndoState | null {
    if (!this.entry) return null
    if (this.entry.state.expiresAt <= now) return null
    return { ...this.entry.state }
  }

  take(): { kind: UndoKind; ids: string[] } | null {
    if (!this.entry) return null
    if (this.entry.state.expiresAt <= Date.now()) {
      this.clear()
      return null
    }
    const taken = { kind: this.entry.kind, ids: [...this.entry.ids] }
    this.clear()
    return taken
  }

  clear(): void {
    this.clearTimer()
    this.entry = null
    this.onChange()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
