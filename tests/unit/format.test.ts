import { describe, expect, it } from 'vitest'
import {
  formatAccelerator,
  formatBytes,
  formatCountdown,
  formatShortTtl,
  humanTypeLabel,
  truncateMiddle
} from '../../src/shared/format'

describe('format helpers', () => {
  it('formats bytes with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB')
  })

  it('formats countdowns for cards and toasts', () => {
    expect(formatCountdown(null)).toBe('永久')
    expect(formatCountdown(-1)).toBe('已到期')
    expect(formatCountdown(30_000)).toBe('即将过期')
    expect(formatCountdown(23 * 60 * 60_000)).toBe('23 小时后过期')
    expect(formatShortTtl(90 * 60_000)).toBe('2 小时')
    expect(formatShortTtl(25 * 60 * 60_000)).toBe('2 天')
  })

  it('turns Electron accelerators into readable key labels', () => {
    expect(formatAccelerator('Control+Alt+Space')).toBe('Ctrl + Alt + 空格')
    expect(formatAccelerator('Control+Shift+D')).toBe('Ctrl + Shift + D')
  })

  it('labels file types', () => {
    expect(humanTypeLabel('file', 'pdf')).toBe('PDF')
    expect(humanTypeLabel('folder', null)).toBe('文件夹')
    expect(humanTypeLabel('text', null)).toBe('文本')
    expect(humanTypeLabel('url', null)).toBe('链接')
  })

  it('truncates in the middle', () => {
    const result = truncateMiddle('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 10)
    expect(result).toContain('…')
    expect(result.length).toBeLessThanOrEqual(10)
  })
})
