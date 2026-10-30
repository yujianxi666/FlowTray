import { TRASH_RETENTION_MS } from '@shared/constants'
import { logger } from '@main/lib/logger'
import type { DragService } from '@main/services/drag'
import type { ItemService } from '@main/services/items'

export interface LifecycleCallbacks {
  onExpired: (ids: string[]) => void
  onRemind: (count: number) => void
  onChange: () => void
}

export class Lifecycle {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private lastPurgeAt = 0
  private lastVerifyAt = 0
  private lastStagingCleanup = 0

  constructor(
    private readonly items: ItemService,
    private readonly drag: DragService,
    private readonly callbacks: LifecycleCallbacks
  ) {}

  async boot(): Promise<void> {
    await this.items.ensureLayout()
    const verified = await this.items.verify()
    if (verified.missing > 0) {
      logger.info('lifecycle.startup_missing', { count: verified.missing })
    }
    const expired = await this.items.sweepExpired()
    if (expired.expired > 0) {
      this.callbacks.onExpired(expired.ids)
    }
    await this.items.purgeTrash(Date.now() - TRASH_RETENTION_MS)
    await this.drag.cleanupStaging()
    this.lastPurgeAt = Date.now()
    this.lastVerifyAt = Date.now()
    this.lastStagingCleanup = Date.now()
    this.callbacks.onChange()
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, 30_000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    const now = Date.now()
    try {
      const expired = await this.items.sweepExpired(now)
      if (expired.expired > 0) {
        this.callbacks.onExpired(expired.ids)
      }
      if (expired.remind > 0) {
        this.callbacks.onRemind(expired.remind)
      }
      if (now - this.lastVerifyAt > 3 * 60_000) {
        await this.items.verify()
        this.lastVerifyAt = now
      }
      if (now - this.lastPurgeAt > 60 * 60_000) {
        await this.items.purgeTrash(now - TRASH_RETENTION_MS)
        this.lastPurgeAt = now
      }
      if (now - this.lastStagingCleanup > 60 * 60_000) {
        await this.drag.cleanupStaging()
        this.lastStagingCleanup = now
      }
    } catch (error) {
      logger.warn('lifecycle.tick_failed', { error })
    } finally {
      this.busy = false
    }
  }

  async verifyNow(): Promise<void> {
    await this.items.verify()
  }
}
