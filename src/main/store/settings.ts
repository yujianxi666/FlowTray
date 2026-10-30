import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  sanitizeSensitiveList,
  settingsPatchSchema,
  type Settings,
  type SettingsPatch
} from '@shared/settings'
import type { Database } from './db'
import { logger } from '@main/lib/logger'

export interface SettingsUpdate {
  ok: boolean
  settings: Settings
  errors: Array<{ field: string; message: string }>
  changed: string[]
}

export class SettingsStore {
  private value: Settings

  constructor(private readonly db: Database) {
    this.value = this.load()
  }

  get(): Settings {
    return { ...this.value }
  }

  private load(): Settings {
    const raw: Record<string, unknown> = {}
    try {
      const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')
      for (const row of rows) {
        try {
          raw[row.key] = JSON.parse(row.value)
        } catch {
          logger.warn('settings.invalid_row', { key: row.key })
        }
      }
    } catch (error) {
      logger.error('settings.load_failed', { error })
    }
    const normalized = normalizeSettings(raw)
    this.persist(normalized)
    return normalized
  }

  private persist(settings: Settings): void {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        this.db.run(
          'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          JSON.stringify(value)
        )
      }
    })
  }

  update(patch: SettingsPatch): SettingsUpdate {
    const parsed = settingsPatchSchema.safeParse(patch)
    if (!parsed.success) {
      return {
        ok: false,
        settings: this.get(),
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || 'settings',
          message: issue.message
        })),
        changed: []
      }
    }
    const candidate: Settings = { ...this.value, ...parsed.data }
    if (parsed.data.sensitiveApps) {
      candidate.sensitiveApps = sanitizeSensitiveList(parsed.data.sensitiveApps)
    }
    if (parsed.data.sensitiveTitles) {
      candidate.sensitiveTitles = sanitizeSensitiveList(parsed.data.sensitiveTitles)
    }
    const normalized = normalizeSettings(candidate)
    const changed = Object.entries(normalized)
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(this.value[key as keyof Settings]))
      .map(([key]) => key)
    this.value = normalized
    this.persist(normalized)
    logger.info('settings.updated', { keys: changed })
    return { ok: true, settings: this.get(), errors: [], changed }
  }

  setStorageDir(path: string): void {
    this.value = { ...this.value, storageDir: path }
    this.db.run(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      'storageDir',
      JSON.stringify(path)
    )
  }

  reset(): SettingsUpdate {
    const next: Settings = {
      ...DEFAULT_SETTINGS,
      storageDir: this.value.storageDir,
      onboardingDone: this.value.onboardingDone
    }
    this.value = next
    this.persist(next)
    logger.info('settings.reset')
    return { ok: true, settings: this.get(), errors: [], changed: Object.keys(next) }
  }
}
