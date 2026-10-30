import { ipcMain } from 'electron'
import { z } from 'zod'
import { MAX_IMAGE_BYTES, MAX_TEXT_CHARS } from '@shared/constants'
import { IPC } from '@shared/ipc'
import { settingsPatchSchema } from '@shared/settings'
import { logger } from '@main/lib/logger'
import { foreground } from '@main/services/foreground'
import type { AppController } from '@main/app-controller'
import type { AddPathsOptions, DragOutPayload } from '@shared/types'

const idSchema = z.string().min(1).max(100)
const idsSchema = z.array(idSchema).min(1).max(300)

const addPathsSchema = z.object({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(200),
  options: z
    .object({
      effect: z.enum(['copy', 'cut']).optional(),
      sourceApp: z.string().max(120).nullable().optional(),
      source: z.enum(['drop', 'clipboard', 'manual']).optional()
    })
    .optional()
})

const addTextSchema = z.object({
  text: z.string().max(MAX_TEXT_CHARS + 10_000),
  html: z.string().max(1_000_000).nullable().optional(),
  sourceApp: z.string().max(120).nullable().optional(),
  source: z.enum(['drop', 'clipboard', 'manual']).optional()
})

const seedSchema = z.array(
  z.object({
    type: z.enum(['text', 'url', 'file', 'image', 'folder']),
    text: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
    name: z.string().max(200).optional(),
    pinned: z.boolean().optional(),
    expiresAt: z.number().nullable().optional(),
    sourceApp: z.string().nullable().optional()
  })
).max(300)

export function registerIpc(controller: AppController): void {
  const authorized = (senderId: number): boolean => {
    const window = controller.shelf.window
    return Boolean(window && !window.isDestroyed() && window.webContents.id === senderId)
  }

  const handle = <T extends unknown[]>(
    channel: string,
    handler: (...args: T) => unknown
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!authorized(event.sender.id)) throw new Error('unauthorized')
      return handler(...(args as T))
    })
  }

  handle(IPC.snapshotGet, () => controller.getSnapshot())
  handle(IPC.foreground, () => foreground.get())
  handle(IPC.windowToggle, () => controller.toggleShelf())
  handle(IPC.windowHide, () => controller.hideShelf())
  handle(IPC.quit, () => controller.quit())
  handle(IPC.restart, () => controller.restart())
  handle(IPC.restartAdmin, () => controller.restartAdmin())
  handle(IPC.openDataDir, () => controller.openDataDir())
  handle(IPC.openLogsDir, () => controller.openLogsDir())

  handle(IPC.itemsAddPaths, (payload: unknown) => {
    const parsed = addPathsSchema.parse(payload)
    return controller.addPaths(parsed.paths, (parsed.options ?? {}) as AddPathsOptions)
  })

  handle(IPC.itemsAddText, (payload: unknown) => {
    const parsed = addTextSchema.parse(payload)
    return controller.addText(parsed)
  })

  handle(IPC.itemsAddUrls, (payload: unknown) => {
    const parsed = z
      .object({
        urls: z.array(z.string().min(1).max(4096)).min(1).max(20),
        sourceApp: z.string().max(120).nullable().optional()
      })
      .parse(payload)
    return controller.addUrls(parsed.urls, parsed.sourceApp ?? null)
  })

  handle(IPC.itemsAddClipboard, () => controller.captureFromShelf())

  handle(IPC.itemsAddImageBuffer, async (payload: unknown) => {
    const parsed = z
      .object({
        data: z.instanceof(ArrayBuffer),
        mime: z.string().max(120),
        name: z.string().max(200).optional(),
        sourceApp: z.string().max(120).nullable().optional()
      })
      .parse(payload)
    if (parsed.data.byteLength > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        added: 0,
        duplicates: 0,
        errors: [{ code: 'too_large', message: '图片超过 64 MB，未添加。' }]
      }
    }
    return controller.addImageBuffer(parsed)
  })

  handle(IPC.itemsUpdate, (payload: unknown) => {
    const parsed = z
      .object({
        id: idSchema,
        patch: z.object({
          pinned: z.boolean().optional(),
          name: z.string().max(120).optional()
        })
      })
      .parse(payload)
    return controller.updateItem(parsed.id, parsed.patch)
  })

  handle(IPC.itemsPin, (payload: unknown) => {
    const parsed = z.object({ ids: idsSchema, pinned: z.boolean() }).parse(payload)
    return controller.pinItems(parsed.ids, parsed.pinned)
  })

  handle(IPC.itemsRemove, (payload: unknown) => {
    const parsed = z.object({ ids: idsSchema }).parse(payload)
    return controller.removeItems(parsed.ids)
  })

  handle(IPC.itemsClear, (payload: unknown) => {
    const parsed = z.object({ includePinned: z.boolean().optional() }).parse(payload ?? {})
    return controller.clearItems(Boolean(parsed.includePinned))
  })

  handle(IPC.itemsUndo, () => controller.restoreUndo())

  handle(IPC.itemsCopy, (payload: unknown) => {
    const parsed = z
      .object({
        ids: idsSchema,
        kind: z.enum(['auto', 'files', 'path', 'text']).optional()
      })
      .parse(payload)
    return controller.copyItems(parsed.ids, parsed.kind ?? 'auto')
  })

  handle(IPC.itemsOpen, (payload: unknown) => {
    const parsed = z.object({ id: idSchema }).parse(payload)
    return controller.openItem(parsed.id)
  })

  handle(IPC.itemsReveal, (payload: unknown) => {
    const parsed = z.object({ id: idSchema }).parse(payload)
    return controller.revealItem(parsed.id)
  })

  handle(IPC.itemsRelocate, (payload: unknown) => {
    const parsed = z.object({ id: idSchema }).parse(payload)
    return controller.relocateItem(parsed.id)
  })

  handle(IPC.itemsRestoreOriginal, (payload: unknown) => {
    const parsed = z.object({ id: idSchema }).parse(payload)
    return controller.restoreOriginal(parsed.id)
  })

  handle(IPC.itemsDetail, (payload: unknown) => {
    const parsed = z.object({ id: idSchema }).parse(payload)
    return controller.getDetail(parsed.id)
  })

  ipcMain.on(IPC.itemsStartDrag, (event, payload: unknown) => {
    if (!authorized(event.sender.id)) return
    try {
      const parsed = z
        .object({
          ids: idsSchema,
          effect: z.enum(['copy', 'cut']),
          iconDataUrl: z.string().max(2_000_000).nullable().optional()
        })
        .parse(payload)
      void controller.startDrag(parsed as DragOutPayload).catch((error) => {
        logger.warn('ipc.start_drag_failed', { error })
      })
    } catch (error) {
      logger.warn('ipc.invalid_start_drag', { error })
    }
  })

  ipcMain.on(IPC.itemsDragEnded, (event, payload: unknown) => {
    if (!authorized(event.sender.id)) return
    try {
      const parsed = z
        .object({ ids: idsSchema, effect: z.enum(['copy', 'cut']) })
        .parse(payload)
      controller.onDragEnded(parsed)
    } catch {
      // ignore
    }
  })

  handle(IPC.settingsUpdate, (payload: unknown) => {
    if (payload && typeof payload === 'object' && 'storageDir' in payload) {
      return {
        ok: false,
        errors: [{ field: 'storageDir', message: '请使用“更改存储位置”来迁移数据。' }]
      }
    }
    const parsed = settingsPatchSchema.safeParse(payload)
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'settings',
          message: issue.message
        }))
      }
    }
    return controller.updateSettings(parsed.data)
  })

  handle(IPC.settingsReset, () => controller.resetSettings())
  handle(IPC.settingsChooseStorage, () => controller.chooseStorageDir())
  handle(IPC.settingsOpenStorage, () => controller.openStorageDir())
  handle(IPC.settingsClearData, (payload: unknown) => {
    const parsed = z.object({ includeSettings: z.boolean() }).parse(payload)
    return controller.clearAllData(parsed.includeSettings)
  })

  ipcMain.on(IPC.windowResizeLive, (event, payload: unknown) => {
    if (!authorized(event.sender.id)) return
    try {
      const parsed = z
        .object({ width: z.number().min(300).max(1200), height: z.number().min(400).max(1400) })
        .parse(payload)
      controller.shelf.setSizeLive(parsed.width, parsed.height)
    } catch {
      // ignore
    }
  })

  ipcMain.on(IPC.windowResizeEnd, (event) => {
    if (!authorized(event.sender.id)) return
    controller.commitWindowSize()
  })

  ipcMain.on(IPC.windowInteractionLock, (event, locked: unknown) => {
    if (!authorized(event.sender.id)) return
    controller.shelf.setInteractionLocked(locked === true)
  })

  handle(IPC.shortcutsSuspend, () => controller.suspendShortcuts())
  handle(IPC.shortcutsResume, () => controller.resumeShortcuts())

  ipcMain.on(IPC.e2eFlag, (event) => {
    if (!authorized(event.sender.id)) {
      event.returnValue = false
      return
    }
    event.returnValue = process.env.FLOWTRAY_E2E === '1'
  })

  const e2eGuard = (): boolean => process.env.FLOWTRAY_E2E === '1'

  handle(IPC.e2eSeed, (payload: unknown) => {
    if (!e2eGuard()) return { ok: false, added: 0, duplicates: 0, errors: [] }
    const parsed = seedSchema.parse(payload)
    return controller.seedE2E(parsed)
  })

  handle(IPC.e2eSettings, (payload: unknown) => {
    if (!e2eGuard()) return { ok: false, errors: [] }
    const parsed = settingsPatchSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, errors: [] }
    return controller.updateSettings(parsed.data)
  })

  handle(IPC.e2eOpenOnboarding, () => {
    if (!e2eGuard()) return
    controller.openOnboardingE2E()
  })

  handle(IPC.e2eOpenSettings, (payload: unknown) => {
    if (!e2eGuard()) return
    const parsed = z.object({ section: z.string().max(40).optional() }).parse(payload ?? {})
    controller.openSettingsE2E(parsed.section as never)
  })

  handle(IPC.e2eClearAll, () => {
    if (!e2eGuard()) return
    return controller.clearItems(true)
  })

  handle(IPC.e2eSweep, async () => {
    if (!e2eGuard()) return
    await controller.runLifecycleForE2E()
  })

  handle(IPC.e2eFlush, async () => {
    if (!e2eGuard()) return
    await new Promise((resolve) => setTimeout(resolve, 80))
    controller.scheduleBroadcast()
    await new Promise((resolve) => setTimeout(resolve, 80))
    return true
  })
}
