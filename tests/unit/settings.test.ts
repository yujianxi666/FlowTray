import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  isSensitiveSource,
  normalizeSettings,
  sanitizeSensitiveList
} from '@shared/settings'

describe('settings normalization', () => {
  it('fills missing keys with defaults', () => {
    const settings = normalizeSettings({ theme: 'light' })
    expect(settings.theme).toBe('light')
    expect(settings.defaultTtl).toBe('24h')
    expect(settings.shelfWidth).toBe(396)
    expect(settings.hotkeyToggle).toBe('Control+Alt+Space')
    expect(settings.launchAsAdmin).toBe(false)
  })

  it('falls back to defaults for invalid values', () => {
    const settings = normalizeSettings({
      theme: 'neon',
      capacityMb: -4,
      shelfWidth: 9999,
      hotkeyToggle: ''
    })
    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(settings.capacityMb).toBe(DEFAULT_SETTINGS.capacityMb)
    expect(settings.shelfWidth).toBe(DEFAULT_SETTINGS.shelfWidth)
    expect(settings.hotkeyToggle).toBe(DEFAULT_SETTINGS.hotkeyToggle)
  })

  it('normalizes and de-duplicates the private-app list', () => {
    const apps = sanitizeSensitiveList([' KeePass ', 'keepass', '1Password', '', '  '])
    expect(apps).toEqual(['keepass', '1password'])
  })
})

describe('sensitive source detection', () => {
  const apps = ['keepassxc', '1password', 'bitwarden']
  const titles = ['password', '密码']

  it('matches password-manager processes case-insensitively', () => {
    expect(
      isSensitiveSource({ processName: 'KeePassXC.exe', title: 'Database' }, apps, titles)
    ).toBe(true)
    expect(isSensitiveSource({ processName: 'chrome', title: 'Business' }, apps, titles)).toBe(
      false
    )
  })

  it('matches sensitive words in the window title', () => {
    expect(
      isSensitiveSource({ processName: 'chrome', title: '登录 - 密码管理器' }, apps, titles)
    ).toBe(true)
    expect(
      isSensitiveSource({ processName: 'notepad', title: 'Password rotation notes' }, apps, titles)
    ).toBe(true)
  })

  it('does not treat every browser as sensitive', () => {
    expect(
      isSensitiveSource({ processName: 'chrome', title: 'FlowTray 文档' }, apps, titles)
    ).toBe(false)
  })
})
