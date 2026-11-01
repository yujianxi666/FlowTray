import { describe, expect, it } from 'vitest'
import type { ShelfItemView } from '../../src/shared/types'
import {
  fileTypeClass,
  invertedEffect,
  isFileLike,
  itemTypeMatches,
  matchesQuery,
  metaLine,
  modifierPressed,
  sourceLabel,
  ttlTone,
  typeLabel
} from '../../src/lib/utils'

const base: ShelfItemView = {
  id: 'it_1',
  type: 'file',
  name: '产品需求 v2.pdf',
  preview: null,
  textContent: null,
  textLength: null,
  url: null,
  path: 'C:\\Users\\alice\\Desktop\\产品需求 v2.pdf',
  ext: 'pdf',
  size: 1024 * 1024,
  sourceApp: '资源管理器',
  source: 'drop',
  createdAt: Date.now() - 1000,
  expiresAt: Date.now() + 24 * 60 * 60_000,
  pinned: false,
  status: 'active',
  storageMode: 'reference',
  hasThumb: false,
  thumbUrl: null,
  movedIn: false,
  expiresInMs: 24 * 60 * 60_000,
  expiringSoon: false
}

describe('item presentation helpers', () => {
  it('formats meta for files, text and links', () => {
    expect(metaLine(base).slice(0, 2)).toEqual(['PDF', '1 MB'])
    const text: ShelfItemView = {
      ...base,
      type: 'text',
      name: '一条笔记',
      ext: null,
      textLength: 1200,
      textContent: '一条笔记'
    }
    expect(metaLine(text)[0]).toBe('文本')
    expect(metaLine(text)[1]).toContain('1.2k')
    const url: ShelfItemView = {
      ...base,
      type: 'url',
      name: 'electronjs.org',
      ext: null,
      url: 'https://www.electronjs.org/docs'
    }
    expect(metaLine(url)[1]).toBe('www.electronjs.org')
  })

  it('labels sources and types', () => {
    expect(sourceLabel(base)).toBe('资源管理器')
    expect(typeLabel(base)).toBe('PDF')
    expect(sourceLabel({ ...base, sourceApp: null })).toBe('本地拖入')
    expect(fileTypeClass(base)).toBe('pdf')
    const folder = { ...base, type: 'folder' as const, ext: null }
    expect(fileTypeClass(folder)).toBe('folder')
    expect(isFileLike(folder)).toBe(true)
    expect(isFileLike({ ...base, type: 'text' })).toBe(false)
  })

  it('filters by type including folders under files', () => {
    expect(itemTypeMatches({ ...base, type: 'folder' }, 'file')).toBe(true)
    expect(itemTypeMatches(base, 'image')).toBe(false)
    expect(itemTypeMatches(base, 'all')).toBe(true)
  })

  it('searches name, content, URL and source', () => {
    expect(matchesQuery(base, '产品')).toBe(true)
    expect(matchesQuery(base, '资源')).toBe(true)
    expect(matchesQuery(base, '不存在')).toBe(false)
    const text = { ...base, type: 'text' as const, textContent: '关于青柠的设计说明' }
    expect(matchesQuery(text, '青柠')).toBe(true)
    expect(matchesQuery(text, '青柠 设计')).toBe(true)
  })

  it('tones expiry and supports inverted drag effects', () => {
    expect(ttlTone({ ...base, pinned: true })).toBe('pinned')
    expect(ttlTone({ ...base, status: 'missing' })).toBe('missing')
    expect(ttlTone({ ...base, expiresAt: Date.now() + 5 * 60_000 })).toBe('soon')
    expect(ttlTone({ ...base, expiresAt: null })).toBe('never')
    expect(invertedEffect('copy', true)).toBe('cut')
    expect(invertedEffect('cut', true)).toBe('copy')
    expect(invertedEffect('copy', false)).toBe('copy')
    expect(modifierPressed({ ctrlKey: true, shiftKey: false, altKey: false }, 'ctrl')).toBe(true)
    expect(modifierPressed({ ctrlKey: false, shiftKey: true, altKey: false }, 'alt')).toBe(false)
  })
})
