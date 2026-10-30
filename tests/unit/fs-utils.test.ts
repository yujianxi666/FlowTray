import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fileIdentity,
  hashText,
  isPathInside,
  isProtectedPath,
  normalizeIdentityPath,
  resolveUnder,
  sanitizeFileName,
  uniqueDestination
} from '@main/lib/fs-utils'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'flowtray-unit-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('filename safety', () => {
  it('strips illegal Windows characters', () => {
    expect(sanitizeFileName('a<b>:c?.pdf')).not.toMatch(/[<>:"/\\|?*]/)
    expect(sanitizeFileName('   .pdf  ')).toBe('.pdf')
  })

  it('protects reserved device names', () => {
    expect(sanitizeFileName('CON.txt')).toBe('CON_.txt')
    expect(sanitizeFileName('NUL')).toBe('NUL_')
  })

  it('finds a free filename', async () => {
    const directory = join(root, 'destination')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'report.pdf'), 'one')
    const destination = await uniqueDestination(directory, 'report.pdf')
    expect(destination).toContain('report (2).pdf')
  })
})

describe('path containment', () => {
  it('detects children', () => {
    expect(isPathInside(join(root, 'a', 'b'), root)).toBe(true)
    expect(isPathInside(root, join(root, 'a'))).toBe(false)
  })

  it('rejects absolute and traversal relative references', () => {
    expect(resolveUnder(root, 'files/a.txt')).toBe(join(root, 'files', 'a.txt'))
    expect(resolveUnder(root, '../secret.txt')).toContain(root)
    expect(resolveUnder(root, 'C:\\Windows\\system.ini')).toBeNull()
  })

  it('blocks Windows system locations from cut operations', () => {
    if (process.platform !== 'win32') return
    expect(isProtectedPath('C:\\Windows\\System32\\drivers\\etc\\hosts', join(root, 'storage'))).toBe(
      true
    )
    expect(isProtectedPath(join(root, 'storage', 'files', 'a.txt'), join(root, 'storage'))).toBe(
      true
    )
    expect(isProtectedPath(join(root, 'ordinary.txt'), join(root, 'storage'))).toBe(false)
  })
})

describe('file identity', () => {
  it('is case-insensitive on Windows paths', () => {
    const stat = { size: 12, mtimeMs: 1700000000000 }
    const a = fileIdentity('C:\\Temp\\Report.PDF', stat, 'file')
    const b = fileIdentity('c:\\temp\\report.pdf', stat, 'file')
    expect(a).toBe(b)
  })

  it('normalizes separators', () => {
    expect(normalizeIdentityPath('C:/Temp/A.TXT')).toContain('\\temp\\a.txt')
  })

  it('hashes text deterministically', () => {
    expect(hashText('flow')).toBe(hashText('flow'))
    expect(hashText('flow')).not.toBe(hashText('tray'))
  })
})
