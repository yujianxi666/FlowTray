import { screen } from 'electron'
import type { Settings } from '@shared/settings'
import type { ShelfWindow } from '@main/window/shelf'

/**
 * Edge-reveal shows a narrow handle when the pointer is in the outer quarter of
 * the screen, then expands the shelf when the pointer rests on the actual edge.
 * Cursor polling is used instead of a global hook so it keeps working during a
 * native file drag without requiring native addons or elevated rights.
 */
export class EdgeReveal {
  private timer: NodeJS.Timeout | null = null
  private dwellStartedAt = 0
  private armed = true
  private lastRevealAt = 0
  private lastPeekY: number | null = null

  constructor(
    private readonly shelf: ShelfWindow,
    private readonly getSettings: () => Settings
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 150)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.shelf.hidePeek()
    this.lastPeekY = null
  }

  private tick(): void {
    const settings = this.getSettings()
    if (!settings.edgeReveal) {
      this.dwellStartedAt = 0
      this.shelf.hidePeek()
      this.lastPeekY = null
      return
    }
    if (this.shelf.isFullVisible()) {
      this.dwellStartedAt = 0
      this.lastPeekY = null
      this.armed = false
      this.shelf.hidePeek()
      return
    }

    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const area = display.workArea
    const edgeX = settings.shelfSide === 'right' ? area.x + area.width - 1 : area.x
    const distance = Math.abs(point.x - edgeX)
    const quarter = Math.max(120, area.width * 0.25)
    const inVerticalRange = point.y >= area.y && point.y <= area.y + area.height
    const nearEdge = distance <= quarter && inVerticalRange

    if (!nearEdge) {
      this.dwellStartedAt = 0
      this.shelf.hidePeek()
      this.lastPeekY = null
      if (distance > 80) this.armed = true
      return
    }

    // A thin, click-through handle gives the user a visual target before the
    // full shelf opens. It follows the pointer but is not a focusable window.
    if (
      this.lastPeekY === null ||
      Math.abs(this.lastPeekY - point.y) > 6 ||
      !this.shelf.isPeeking()
    ) {
      this.shelf.showPeek(point, display)
      this.lastPeekY = point.y
    }

    if (distance > 4) {
      this.dwellStartedAt = 0
      return
    }
    if (!this.armed) return
    const now = Date.now()
    if (now - this.lastRevealAt < 900) return
    if (this.dwellStartedAt === 0) {
      this.dwellStartedAt = now
      return
    }
    if (now - this.dwellStartedAt >= settings.edgeDelayMs) {
      this.dwellStartedAt = 0
      this.armed = false
      this.lastRevealAt = now
      this.lastPeekY = null
      this.shelf.show('edge', false)
    }
  }

  rearm(): void {
    this.armed = true
    this.dwellStartedAt = 0
  }
}
