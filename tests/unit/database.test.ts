import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '@main/store/db'

let directory: string
let file: string

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'flowtray-db-'))
  file = join(directory, 'test.db')
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('database', () => {
  it('creates the schema and persists rows', () => {
    const db = new Database(file)
    db.run(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      'defaultTtl',
      '"24h"'
    )
    const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'defaultTtl')
    expect(row?.value).toBe('"24h"')
    db.close()

    const reopened = new Database(file)
    expect(
      reopened.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'defaultTtl')?.value
    ).toBe('"24h"')
    reopened.close()
  })

  it('rolls back failed transactions', () => {
    const db = new Database(file)
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO settings(key, value) VALUES(?, ?)', 'rolledBack', '"x"')
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(db.get('SELECT value FROM settings WHERE key = ?', 'rolledBack')).toBeUndefined()
    db.close()
  })
})
