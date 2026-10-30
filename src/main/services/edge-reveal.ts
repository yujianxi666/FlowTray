import { screen } from 'electron'
import type { Settings } from '@shared/settings'
import type { ShelfWindow } from '@main/window/shelf'

/**
 * Edge-reveal makes the shelf appear when the pointer rests at the screen edge.
 * It uses cursor polling rather than a global mouse hook, so it also works while
 * a file drag is in progress, without requiring native addons or elevated rights.
 */
export class EdgeReveal {
  private timer: NodeJS.Timeout | null = null
  private dwellStartedAt = 0
  private armed = true
  private lastRevealAt = 0

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
  }

  private tick(): void {
    const settings = this.getSettings()
    if (!settings.edgeReveal) {
      this.dwellStartedAt = 0
      return
    }
    if (this.shelf.isVisible()) {
      this.dwellStartedAt = 0
      this.armed = false
      return
    }
    const now = Date.now()
    if (now - this.lastRevealAt < 900) return

    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const area = display.workArea
    const edgeX = settings.shelfSide === 'right' ? area.x + area.width - 1 : area.x
    const inVerticalRange =
      point.y >= area.y + area.height * 0.15 &&
      point.y <= area.y + area.height * 0.85
    const inEdge = Math.abs(point.x - edgeX) <= 4 && inVerticalRange

    if (!inEdge) {
      this.dwellStartedAt = 0
      const distance = Math.abs(point.x - edgeX)
      if (distance > 80) this.armed = true
      return
    }
    if (!this.armed) return
    if (this.dwellStartedAt === 0) {
      this.dwellStartedAt = now
      return
    }
    if (now - this.dwellStartedAt >= settings.edgeDelayMs) {
      this.dwellStartedAt = 0
      this.armed = false
      this.lastRevealAt = now
      this.shelf.show('edge', false)
    }
  }

  rearm(): void {
    this.armed = true
    this.dwellStartedAt = 0
  }
}
