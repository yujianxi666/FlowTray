import { nativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { pathExists, ensureDir, sanitizeFileName, uniqueDestination, removePath } from '@main/lib/fs-utils'
import { dragCacheDir, appIconPath } from '@main/lib/paths'
import { logger } from '@main/lib/logger'
import type { ItemService, ItemRow } from '@main/services/items'
import type { SettingsStore } from '@main/store/settings'
import type { ShelfWindow } from '@main/window/shelf'
import type { DragEffect, DragOutPayload } from '@shared/types'

const COPY_STAGE_LIMIT = 64 * 1024 * 1024

export interface DragPreparation {
  files: string[]
  staged: boolean
  warnings: string[]
  skipped: string[]
}

export class DragService {
  constructor(
    private readonly items: ItemService,
    private readonly shelf: ShelfWindow,
    private readonly settings: SettingsStore
  ) {}

  async prepare(rows: ItemRow[], effect: DragEffect): Promise<DragPreparation> {
    const files: string[] = []
    const warnings: string[] = []
    const skipped: string[] = []
    const copy = effect === 'copy' && this.settings.get().safeDragCopy
    const stagingRoot = join(dragCacheDir(), `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    let staged = false

    for (const row of rows) {
      const source = this.items.resolveItemPath(row)
      if (!source || !pathExists(source)) {
        skipped.push(row.name)
        continue
      }
      if (!copy) {
        files.push(source)
        continue
      }

      try {
        await ensureDir(stagingRoot)
        const destination = await uniqueDestination(stagingRoot, basename(source))
        const isDirectory = row.type === 'folder'
        let usedStage = false
        if (isDirectory) {
          try {
            await fs.symlink(source, destination, 'junction')
            usedStage = true
          } catch {
            usedStage = false
          }
        } else {
          try {
            await fs.link(source, destination)
            usedStage = true
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'EXDEV') {
              try {
                const stat = await fs.stat(source)
                if (stat.size <= COPY_STAGE_LIMIT) {
                  await fs.copyFile(source, destination)
                  usedStage = true
                }
              } catch {
                usedStage = false
              }
            }
          }
        }
        if (usedStage) {
          files.push(destination)
          staged = true
        } else {
          files.push(source)
          warnings.push(
            isDirectory
              ? `「${row.name}」是跨磁盘文件夹，已按原路径拖出。`
              : `「${row.name}」超过 64 MB 且无法创建安全副本，已按原路径拖出。`
          )
        }
      } catch (error) {
        logger.warn('drag.stage_failed', { id: row.id, error })
        files.push(source)
      }
    }

    if (!staged) {
      await removePath(stagingRoot)
    }
    return { files, staged, warnings, skipped }
  }

  async startNativeDrag(payload: DragOutPayload): Promise<void> {
    const rows = this.items.getFileLikeRows(payload.ids)
    if (rows.length === 0) {
      this.shelf.sendCommand({
        type: 'toast',
        tone: 'error',
        message: '这些卡片没有可拖出的文件，请改用复制。'
      })
      return
    }
    const preparation = await this.prepare(rows, payload.effect)
    if (preparation.files.length === 0) {
      this.shelf.sendCommand({
        type: 'toast',
        tone: 'error',
        message: '文件已失效或不可访问，无法拖出。'
      })
      return
    }

    const icon = this.resolveIcon(payload.iconDataUrl)
    this.shelf.sendCommand({
      type: 'drag-out-start',
      effect: payload.effect,
      count: rows.length
    })
    this.shelf.sendCommand({
      type: 'toast',
      tone: preparation.warnings.length > 0 ? 'info' : 'info',
      message:
        preparation.warnings.length > 0
          ? preparation.warnings[0]
          : payload.effect === 'cut'
            ? '剪切拖出：松手后文件将从原位置移走。'
            : this.settings.get().safeDragCopy
              ? '正在拖出安全副本，松手放到目标应用即可。'
              : '正在拖出原文件，请在目标处确认复制结果。'
    })

    const window = this.shelf.window
    if (!window || window.isDestroyed()) return
    try {
      window.webContents.startDrag({
        file: preparation.files[0],
        files: preparation.files,
        icon
      })
    } catch (error) {
      logger.warn('drag.start_failed', { error })
      this.shelf.sendCommand({
        type: 'toast',
        tone: 'error',
        message: '拖出失败，请改用复制，或稍后重试。'
      })
    } finally {
      this.shelf.sendCommand({
        type: 'drag-out-end',
        effect: payload.effect,
        count: rows.length
      })
      if (payload.effect === 'cut') {
        setTimeout(() => {
          void this.items.markMovedOut(payload.ids).then((removed) => {
            if (removed > 0) {
              this.shelf.sendCommand({
                type: 'toast',
                tone: 'success',
                message: `已从暂存台移出 ${removed} 项。`
              })
            }
          })
        }, 900)
      }
    }
  }

  private resolveIcon(dataUrl: string | null | undefined) {
    if (dataUrl) {
      try {
        const image = nativeImage.createFromDataURL(dataUrl)
        if (!image.isEmpty()) return image
      } catch {
        // fall through
      }
    }
    try {
      const appIcon = nativeImage.createFromPath(appIconPath())
      if (!appIcon.isEmpty()) {
        return appIcon.resize({ width: 64, height: 64 })
      }
    } catch {
      // fall through
    }
    return nativeImage.createEmpty()
  }

  async cleanupStaging(maxAgeMs = 48 * 60 * 60 * 1000): Promise<void> {
    const root = dragCacheDir()
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      const cutoff = Date.now() - maxAgeMs
      for (const entry of entries) {
        const full = join(root, entry.name)
        try {
          const stat = await fs.stat(full)
          if (stat.mtimeMs < cutoff) {
            await removePath(full)
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // no cache yet
    }
  }
}
