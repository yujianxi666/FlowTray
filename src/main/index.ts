import {
  Menu,
  app,
  dialog,
  net,
  protocol
} from 'electron'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_ID } from '@shared/constants'
import { Database } from '@main/store/db'
import { AppController } from '@main/app-controller'
import { registerIpc } from '@main/ipc'
import { logger } from '@main/lib/logger'
import { dbFile, logsDir, userDataDir } from '@main/lib/paths'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'flowtray',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

// FlowTray uses software rendering by default. The shelf is a small, static
// surface; this removes ~90 MB of private GPU-process memory and keeps the
// portable/installer runtime prunable. Do this before app.ready.
app.disableHardwareAcceleration()

app.setName('FlowTray')
app.setAppUserModelId(APP_ID)

if (process.env.FLOWTRAY_USER_DATA) {
  app.setPath('userData', process.env.FLOWTRAY_USER_DATA)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let controller: AppController | null = null
  let database: Database | null = null
  let shuttingDown = false

  const openDatabase = (): Database => {
    mkdirSync(userDataDir(), { recursive: true })
    try {
      return new Database(dbFile())
    } catch (error) {
      const backup = `${dbFile()}.corrupt-${Date.now()}`
      logger.error('database.open_failed', { error })
      try {
        if (existsSync(dbFile())) renameSync(dbFile(), backup)
        for (const suffix of ['-wal', '-shm']) {
          try {
            if (existsSync(`${dbFile()}${suffix}`)) renameSync(`${dbFile()}${suffix}`, `${backup}${suffix}`)
          } catch {
            // ignore
          }
        }
      } catch {
        throw error
      }
      dialog.showErrorBox(
        'FlowTray 数据文件需要重建',
        `原数据库无法打开，已备份为：\n${backup}\n\nFlowTray 将用新的暂存库继续运行。你的原始文件没有被改动。`
      )
      return new Database(dbFile())
    }
  }

  app.whenReady().then(async () => {
    mkdirSync(logsDir(), { recursive: true })
    logger.init(logsDir(), 'info')
    Menu.setApplicationMenu(null)
    try {
      database = openDatabase()
      controller = new AppController(database)
      registerIpc(controller)

      protocol.handle('flowtray', async (request) => {
        try {
          const url = new URL(request.url)
          if (url.hostname !== 'thumb') {
            return new Response('Not found', { status: 404 })
          }
          const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
          if (!/^[A-Za-z0-9_-]{4,100}$/.test(id)) {
            return new Response('Bad request', { status: 400 })
          }
          const thumb = controller?.items.getThumbPath(id)
          if (!thumb) return new Response('Not found', { status: 404 })
          return net.fetch(pathToFileURL(thumb).toString())
        } catch {
          return new Response('Not found', { status: 404 })
        }
      })

      await controller.bootstrap()
      logger.info('app.ready', {
        version: app.getVersion(),
        packaged: app.isPackaged,
        electron: process.versions.electron
      })
    } catch (error) {
      logger.error('app.bootstrap_failed', { error })
      dialog.showErrorBox(
        'FlowTray 启动失败',
        `应用初始化时遇到问题。\n\n日志：${join(logsDir(), 'main.log')}\n\n${String(
          error instanceof Error ? error.message : error
        )}`
      )
      app.quit()
    }

    app.on('second-instance', () => {
      controller?.showShelf('ipc')
    })

    app.on('activate', () => {
      controller?.showShelf('ipc')
    })

    app.on('window-all-closed', () => {
      // FlowTray stays alive in the tray.
    })

    app.on('before-quit', (event) => {
      if (!controller) return
      if (!controller.isQuitting()) {
        event.preventDefault()
        controller.quit()
        return
      }
      if (!shuttingDown) {
        shuttingDown = true
        controller.shutdown()
      }
    })

    app.on('will-quit', () => {
      logger.info('app.quit')
    })
  })

  process.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', { error })
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', { reason })
  })
}
