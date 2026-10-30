import { app } from 'electron'
import { join } from 'node:path'

export const GUTTER = 0

export function resourcesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
}

export function userDataDir(): string {
  return app.getPath('userData')
}

export function defaultStorageRoot(): string {
  return join(userDataDir(), 'storage')
}

export function resolveStorageRoot(storageDir: string): string {
  const trimmed = storageDir?.trim()
  return trimmed ? trimmed : defaultStorageRoot()
}

export function dbFile(): string {
  return join(userDataDir(), 'flowtray.db')
}

export function logsDir(): string {
  return join(userDataDir(), 'logs')
}

export function dragCacheDir(): string {
  return join(userDataDir(), 'drag-cache')
}

export function appIconPath(): string {
  return join(resourcesDir(), 'tray.png')
}

export function isWindows11(): boolean {
  if (process.platform !== 'win32') return false
  const [major, , build] = process.getSystemVersion().split('.').map((part) => Number(part))
  return major >= 10 && build >= 22000
}
