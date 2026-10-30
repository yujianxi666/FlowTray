import { DatabaseSync } from 'node:sqlite'
import { ensureDirSync } from '@main/lib/fs-utils'
import { dirname } from 'node:path'

export class Database {
  readonly handle: DatabaseSync
  private depth = 0

  constructor(file: string) {
    ensureDirSync(dirname(file))
    this.handle = new DatabaseSync(file)
    this.handle.exec('PRAGMA journal_mode = WAL')
    this.handle.exec('PRAGMA synchronous = NORMAL')
    this.handle.exec('PRAGMA temp_store = MEMORY')
    this.handle.exec('PRAGMA busy_timeout = 4000')
    this.migrate()
  }

  private migrate(): void {
    this.handle.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        ref_path TEXT,
        stored_rel TEXT,
        thumb_rel TEXT,
        storage_mode TEXT NOT NULL DEFAULT 'reference',
        text_content TEXT,
        html_content TEXT,
        url TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        source_app TEXT,
        source TEXT NOT NULL DEFAULT 'drop',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        pinned_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        hash TEXT,
        identity TEXT NOT NULL,
        sort_order REAL NOT NULL DEFAULT 0,
        deleted_at INTEGER,
        last_checked_at INTEGER,
        moved_in INTEGER NOT NULL DEFAULT 0,
        original_path TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
      CREATE INDEX IF NOT EXISTS idx_items_sort ON items(sort_order DESC);
      CREATE INDEX IF NOT EXISTS idx_items_expires ON items(expires_at);
      CREATE INDEX IF NOT EXISTS idx_items_identity ON items(identity);
    `)
    const versionRow = this.handle.prepare('PRAGMA user_version').get() as
      | { user_version?: number }
      | undefined
    if (!versionRow?.user_version) {
      this.handle.exec('PRAGMA user_version = 1')
    }
  }

  all<T>(sql: string, ...params: Array<string | number | null>): T[] {
    const statement = this.handle.prepare(sql)
    return statement.all(...params) as unknown as T[]
  }

  get<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
    const statement = this.handle.prepare(sql)
    return statement.get(...params) as unknown as T | undefined
  }

  run(sql: string, ...params: Array<string | number | null>): void {
    const statement = this.handle.prepare(sql)
    statement.run(...params)
  }

  transaction<T>(callback: () => T): T {
    if (this.depth > 0) return callback()
    this.depth += 1
    this.handle.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.handle.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK')
      } catch {
        // ignore rollback errors
      }
      throw error
    } finally {
      this.depth -= 1
    }
  }

  close(): void {
    try {
      this.handle.close()
    } catch {
      // ignore
    }
  }
}
