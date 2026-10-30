import { z } from 'zod'
import {
  SENSITIVE_APPS_DEFAULT,
  SENSITIVE_TITLES_DEFAULT
} from './constants'

export const settingsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']),
  defaultTtl: z.enum(['1h', '24h', '7d', 'never']),
  expiryReminder: z.boolean(),
  capacityMb: z.number().int().min(0).max(1024 * 1024),
  storageMode: z.enum(['reference', 'copy']),
  storageDir: z.string().max(1024),
  launchAtLogin: z.boolean(),
  launchAsAdmin: z.boolean(),
  openAtLaunch: z.boolean(),
  alwaysOnTop: z.boolean(),
  hideOnBlur: z.boolean(),
  edgeReveal: z.boolean(),
  edgeDelayMs: z.number().int().min(150).max(2000),
  shelfWidth: z.number().int().min(340).max(560),
  shelfHeight: z.number().int().min(480).max(1000),
  shelfSide: z.enum(['left', 'right']),
  viewMode: z.enum(['list', 'grid']),
  showSource: z.boolean(),
  glass: z.boolean(),
  dropEffect: z.enum(['copy', 'cut']),
  dragOutEffect: z.enum(['copy', 'cut']),
  dragModifier: z.enum(['ctrl', 'shift', 'alt']),
  safeDragCopy: z.boolean(),
  clipboardMonitor: z.boolean(),
  clipboardMaxItems: z.number().int().min(10).max(1000),
  sensitiveApps: z.array(z.string().trim().min(1).max(80)).max(100),
  sensitiveTitles: z.array(z.string().trim().min(1).max(80)).max(100),
  hotkeyToggle: z.string().trim().min(3).max(64),
  hotkeyCapture: z.string().trim().min(3).max(64),
  onboardingDone: z.boolean(),
  reduceMotion: z.boolean(),
  logLevel: z.enum(['info', 'debug'])
})

export type Settings = z.infer<typeof settingsSchema>

/** Settings the renderer may change. Storage location is migrated through a dedicated channel. */
export const settingsPatchSchema = settingsSchema.partial().omit({ storageDir: true })
export type SettingsPatch = z.infer<typeof settingsPatchSchema>

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  defaultTtl: '24h',
  expiryReminder: true,
  capacityMb: 2048,
  storageMode: 'reference',
  storageDir: '',
  launchAtLogin: false,
  launchAsAdmin: false,
  openAtLaunch: true,
  alwaysOnTop: true,
  hideOnBlur: false,
  edgeReveal: true,
  edgeDelayMs: 450,
  shelfWidth: 396,
  shelfHeight: 680,
  shelfSide: 'right',
  viewMode: 'list',
  showSource: true,
  glass: true,
  dropEffect: 'copy',
  dragOutEffect: 'copy',
  dragModifier: 'ctrl',
  safeDragCopy: true,
  clipboardMonitor: false,
  clipboardMaxItems: 200,
  sensitiveApps: [...SENSITIVE_APPS_DEFAULT],
  sensitiveTitles: [...SENSITIVE_TITLES_DEFAULT],
  hotkeyToggle: 'Control+Alt+Space',
  hotkeyCapture: 'Control+Shift+D',
  onboardingDone: false,
  reduceMotion: false,
  logLevel: 'info'
}

/** Coerce a possibly legacy/partial row into safe settings. */
export function normalizeSettings(raw: unknown): Settings {
  const candidate =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...DEFAULT_SETTINGS, ...(raw as Record<string, unknown>) }
      : { ...DEFAULT_SETTINGS }
  const parsed = settingsSchema.safeParse(candidate)
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS }
}

export function sanitizeSensitiveList(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed || trimmed.length > 80 || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
    if (result.length >= 100) break
  }
  return result
}

export function isSensitiveSource(
  source: { processName: string; title: string } | null,
  apps: string[],
  titles: string[]
): boolean {
  if (!source) return false
  const process = source.processName.toLowerCase().replace(/\.exe$/i, '').trim()
  const title = source.title.toLowerCase()
  if (process) {
    if (apps.some((app) => app.toLowerCase().trim() === process)) return true
  }
  return titles.some((keyword) => {
    const needle = keyword.toLowerCase().trim()
    return needle.length > 0 && title.includes(needle)
  })
}

