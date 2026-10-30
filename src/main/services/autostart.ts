import { execFile } from 'node:child_process'
import { app } from 'electron'
import { promisify } from 'node:util'
import { logger } from '@main/lib/logger'

const execFileAsync = promisify(execFile)
const TASK_NAME = 'FlowTray'

let elevatedCache: boolean | null = null

export async function isElevated(force = false): Promise<boolean> {
  if (!force && elevatedCache != null) return elevatedCache
  if (process.platform !== 'win32') {
    elevatedCache = false
    return false
  }
  try {
    const { stdout } = await execFileAsync('whoami.exe', ['/groups'], {
      timeout: 2500,
      windowsHide: true,
      maxBuffer: 256 * 1024,
      encoding: 'utf8'
    })
    elevatedCache = stdout.includes('S-1-16-12288') || stdout.includes('S-1-16-16384')
  } catch {
    elevatedCache = false
  }
  return elevatedCache
}

function launchArgs(): string[] {
  return app.isPackaged ? [] : [app.getAppPath()]
}

function commandLine(): string {
  const args = launchArgs()
  const exe = `"${process.execPath}"`
  return args.length > 0 ? `${exe} "${args[0]}"` : exe
}

async function taskExists(): Promise<boolean> {
  try {
    await execFileAsync('schtasks.exe', ['/Query', '/TN', TASK_NAME], {
      timeout: 4000,
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

async function createTask(): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync(
      'schtasks.exe',
      [
        '/Create',
        '/F',
        '/TN',
        TASK_NAME,
        '/SC',
        'ONLOGON',
        '/RL',
        'HIGHEST',
        '/TR',
        commandLine()
      ],
      { timeout: 10_000, windowsHide: true }
    )
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('autostart.task_create_failed', { message })
    return { ok: false, error: '创建管理员自启动任务失败，请以管理员身份重启后再试。' }
  }
}

async function deleteTask(): Promise<void> {
  try {
    await execFileAsync('schtasks.exe', ['/Delete', '/F', '/TN', TASK_NAME], {
      timeout: 6000,
      windowsHide: true
    })
  } catch {
    // Missing tasks are fine.
  }
}

export function setLoginItem(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: launchArgs()
    })
  } catch (error) {
    logger.warn('autostart.login_item_failed', { error })
  }
}

export interface AutostartResult {
  ok: boolean
  warning?: string
  error?: string
}

export async function applyAutostart(settings: {
  launchAtLogin: boolean
  launchAsAdmin: boolean
}): Promise<AutostartResult> {
  if (settings.launchAsAdmin) {
    const elevated = await isElevated()
    if (!elevated) {
      setLoginItem(false)
      return {
        ok: false,
        warning: '管理员自启动需要以管理员身份运行 FlowTray。请使用“以管理员身份重启”。'
      }
    }
    const result = await createTask()
    if (!result.ok) {
      setLoginItem(false)
      return { ok: false, error: result.error }
    }
    setLoginItem(false)
    return { ok: true }
  }

  await deleteTask()
  setLoginItem(settings.launchAtLogin)
  return { ok: true }
}

export async function getAutostartWarning(settings: {
  launchAsAdmin: boolean
}): Promise<string | null> {
  if (!settings.launchAsAdmin) return null
  if (!(await isElevated())) {
    return '已开启管理员自启动，但当前不是管理员进程，任务未能生效。'
  }
  if (!(await taskExists())) {
    return '管理员自启动任务未找到，请重新保存该设置。'
  }
  return null
}

export async function restartAsAdmin(): Promise<void> {
  if (process.platform !== 'win32') return
  const args = launchArgs()
  const argumentList = args.length > 0 ? `-ArgumentList '${args[0].replace(/'/g, "''")}'` : ''
  const script = `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' ${argumentList} -Verb RunAs`
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { timeout: 15_000, windowsHide: true }
    )
  } catch (error) {
    logger.warn('autostart.elevate_failed', { error })
    throw error
  }
}
