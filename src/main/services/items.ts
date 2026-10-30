import { nativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  MAX_DROP_ITEMS,
  MAX_IMAGE_BYTES,
  MAX_ITEMS_TOTAL,
  MAX_TEXT_CHARS,
  computeExpiresAt,
  EXPIRY_REMINDER_MS
} from '@shared/constants'
import type {
  AddPathsOptions,
  AddTextInput,
  IngestEffect,
  ItemError,
  ItemSource,
  ItemStatus,
  ItemType,
  MutationResult,
  ShelfItemDetail,
  ShelfItemView,
  StorageMode,
  StorageUsage
} from '@shared/types'
import { fileExtension, formatBytes } from '@shared/format'
import {
  copyPath,
  ensureDir,
  fileIdentity,
  freeDiskBytes,
  hashBuffer,
  hashText,
  isImagePath,
  isPathInside,
  isProtectedPath,
  movePath,
  pathExists,
  removePath,
  resolveUnder,
  sanitizeFileName,
  toRelative,
  uniqueDestination
} from '@main/lib/fs-utils'
import { errorFromUnknown } from '@main/lib/errors'
import { resolveStorageRoot } from '@main/lib/paths'
import { createId } from '@main/lib/ids'
import { logger } from '@main/lib/logger'
import type { Database } from '@main/store/db'
import type { SettingsStore } from '@main/store/settings'

const MB = 1024 * 1024

export interface ItemRow {
  id: string
  type: ItemType
  name: string
  ref_path: string | null
  stored_rel: string | null
  thumb_rel: string | null
  storage_mode: StorageMode
  text_content: string | null
  html_content: string | null
  url: string | null
  size: number
  source_app: string | null
  source: ItemSource
  created_at: number
  updated_at: number
  expires_at: number | null
  pinned: number
  pinned_at: number | null
  status: ItemStatus
  hash: string | null
  identity: string
  sort_order: number
  deleted_at: number | null
  last_checked_at: number | null
  moved_in: number
  original_path: string | null
  meta: string | null
}

class KnownItemError extends Error {
  constructor(readonly detail: ItemError) {
    super(detail.message)
  }
}

function emptyResult(): MutationResult {
  return { ok: true, added: 0, duplicates: 0, errors: [] }
}

function cleanSourceApp(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80)
  return cleaned || null
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!/^https?:\/\//i.test(trimmed) || /\s/.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.href.length > 4096) return null
    return url.href
  } catch {
    return null
  }
}

function nameForUrl(urlString: string): string {
  try {
    const url = new URL(urlString)
    const path = decodeURIComponent(url.pathname).replace(/\/$/, '')
    const name = `${url.hostname}${path}`
    return truncate(name || url.hostname, 64)
  } catch {
    return truncate(urlString, 64)
  }
}

function titleForText(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0)
  return truncate(line || '文本片段', 56)
}

function previewForText(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), 220)
}

async function directorySize(target: string): Promise<number> {
  let total = 0
  let entries = 0
  const queue = [target]
  while (queue.length > 0) {
    const current = queue.pop() as string
    let listing
    try {
      listing = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of listing) {
      entries += 1
      if (entries > 60_000) return total
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(child)
      } else if (entry.isFile()) {
        try {
          total += (await fs.stat(child)).size
        } catch {
          // ignore
        }
      }
    }
  }
  return total
}

interface SizeAndType {
  size: number
  isDirectory: boolean
}

export class ItemService {
  private notifiedReminders = new Set<string>()

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsStore,
    private readonly onChanged: () => void
  ) {}

  private storageRoot(): string {
    return resolveStorageRoot(this.settings.get().storageDir)
  }

  private filesRoot(): string {
    return join(this.storageRoot(), 'files')
  }

  private thumbsRoot(): string {
    return join(this.storageRoot(), 'thumbs')
  }

  async ensureLayout(): Promise<void> {
    await ensureDir(this.filesRoot())
    await ensureDir(this.thumbsRoot())
  }

  private emit(): void {
    this.onChanged()
  }

  listRows(): ItemRow[] {
    return this.db.all<ItemRow>(
      `SELECT * FROM items
       WHERE status IN ('active', 'missing')
       ORDER BY pinned DESC, pinned_at DESC, sort_order DESC, created_at DESC`
    )
  }

  private rowById(id: string): ItemRow | undefined {
    return this.db.get<ItemRow>('SELECT * FROM items WHERE id = ?', id)
  }

  private activeCount(): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM items WHERE status IN ('active', 'missing')"
    )
    return row?.count ?? 0
  }

  findDuplicate(identity: string): ItemRow | undefined {
    return this.db.get<ItemRow>(
      "SELECT * FROM items WHERE identity = ? AND status IN ('active', 'missing') ORDER BY created_at DESC LIMIT 1",
      identity
    )
  }

  private touchDuplicate(row: ItemRow, sourceApp: string | null): void {
    const now = Date.now()
    const ttl = this.settings.get().defaultTtl
    const expiresAt = row.pinned ? null : computeExpiresAt(ttl, now)
    this.db.run(
      `UPDATE items SET sort_order = ?, updated_at = ?, expires_at = ?, source_app = COALESCE(?, source_app)
       WHERE id = ?`,
      now + 1000,
      now,
      expiresAt,
      sourceApp,
      row.id
    )
  }

  private async insertFileLike(
    sourcePath: string,
    options: AddPathsOptions
  ): Promise<{ added: boolean; duplicate: boolean; error?: ItemError }> {
    const settings = this.settings.get()
    const source = options.source ?? 'drop'
    const sourceApp = cleanSourceApp(options.sourceApp)
    const effect: IngestEffect = options.effect ?? settings.dropEffect
    const storageRoot = this.storageRoot()

    let stat
    try {
      stat = await fs.stat(sourcePath)
    } catch (error) {
      throw new KnownItemError(errorFromUnknown(error, basename(sourcePath)))
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new KnownItemError({
        code: 'unsupported',
        message: '暂不支持这种文件类型（仅支持普通文件与文件夹）。',
        name: basename(sourcePath)
      })
    }

    const isDirectory = stat.isDirectory()
    const type: ItemType = isDirectory ? 'folder' : isImagePath(sourcePath) ? 'image' : 'file'
    const identity = fileIdentity(sourcePath, stat, type)
    const duplicate = this.findDuplicate(identity)
    if (duplicate) {
      this.touchDuplicate(duplicate, sourceApp)
      return { added: false, duplicate: true }
    }

    if (this.activeCount() >= MAX_ITEMS_TOTAL) {
      throw new KnownItemError({
        code: 'quota',
        message: `暂存台已达到 ${MAX_ITEMS_TOTAL} 项上限，请先清理一些内容。`,
        name: basename(sourcePath)
      })
    }

    const cut = effect === 'cut'
    if (cut && isProtectedPath(sourcePath, storageRoot)) {
      throw new KnownItemError({
        code: 'permission',
        message: '系统目录或 FlowTray 数据目录中的内容不能以剪切方式移入。请改为复制。',
        name: basename(sourcePath)
      })
    }

    const useCopy = cut || settings.storageMode === 'copy'
    let storedRel: string | null = null
    let refPath: string | null = null
    let movedIn = false
    let size = stat.size
    let resolvedPath = sourcePath

    if (useCopy) {
      if (isDirectory) {
        size = await directorySize(sourcePath)
      }
      const capacity = settings.capacityMb * MB
      const usage = this.usage()
      if (capacity > 0 && usage.storedBytes + size > capacity) {
        throw new KnownItemError({
          code: 'quota',
          message: `容量不足：还需要 ${formatBytes(size)}，当前上限 ${formatBytes(capacity)}。请在设置中调整上限或清理内容。`,
          name: basename(sourcePath)
        })
      }
      const free = await freeDiskBytes(storageRoot)
      if (Number.isFinite(free) && free < size + 48 * MB) {
        throw new KnownItemError({
          code: 'disk_full',
          message: `磁盘空间不足，至少还需要 ${formatBytes(size + 48 * MB)} 可用空间。`,
          name: basename(sourcePath)
        })
      }

      const id = createId('it_')
      const directory = join(this.filesRoot(), id)
      await ensureDir(directory)
      const destination = await uniqueDestination(directory, basename(sourcePath))
      try {
        if (cut) {
          await movePath(sourcePath, destination, isDirectory)
          movedIn = true
        } else {
          await copyPath(sourcePath, destination, isDirectory)
        }
      } catch (error) {
        await removePath(directory)
        throw new KnownItemError(errorFromUnknown(error, basename(sourcePath)))
      }
      storedRel = toRelative(storageRoot, destination)
      resolvedPath = destination
      if (!isDirectory) {
        try {
          size = (await fs.stat(destination)).size
        } catch {
          // keep original size
        }
      }
      const thumbRel = await this.createThumbnail(id, resolvedPath, type)
      const createdAt = Date.now()
      const sortBase = createdAt + (MAX_DROP_ITEMS * 2)
      const row: ItemRow = {
        id,
        type,
        name: basename(sourcePath),
        ref_path: null,
        stored_rel: storedRel,
        thumb_rel: thumbRel,
        storage_mode: 'copy',
        text_content: null,
        html_content: null,
        url: null,
        size,
        source_app: sourceApp,
        source,
        created_at: createdAt,
        updated_at: createdAt,
        expires_at: computeExpiresAt(settings.defaultTtl, createdAt),
        pinned: 0,
        pinned_at: null,
        status: 'active',
        hash: null,
        identity,
        sort_order: sortBase,
        deleted_at: null,
        last_checked_at: createdAt,
        moved_in: movedIn ? 1 : 0,
        original_path: sourcePath,
        meta: JSON.stringify({ cut, isDirectory })
      }
      this.insertRow(row)
      return { added: true, duplicate: false }
    }

    // Reference mode: keep the original path, generate a small thumbnail only.
    const id = createId('it_')
    const thumbRel = await this.createThumbnail(id, sourcePath, type)
    const createdAt = Date.now()
    refPath = sourcePath
    const row: ItemRow = {
      id,
      type,
      name: basename(sourcePath),
      ref_path: refPath,
      stored_rel: null,
      thumb_rel: thumbRel,
      storage_mode: 'reference',
      text_content: null,
      html_content: null,
      url: null,
      size,
      source_app: sourceApp,
      source,
      created_at: createdAt,
      updated_at: createdAt,
      expires_at: computeExpiresAt(settings.defaultTtl, createdAt),
      pinned: 0,
      pinned_at: null,
      status: 'active',
      hash: null,
      identity,
      sort_order: createdAt + MAX_DROP_ITEMS * 2,
      deleted_at: null,
      last_checked_at: createdAt,
      moved_in: 0,
      original_path: sourcePath,
      meta: JSON.stringify({ isDirectory })
    }
    this.insertRow(row)
    return { added: true, duplicate: false }
  }

  async addPaths(paths: string[], options: AddPathsOptions = {}): Promise<MutationResult> {
    const result = emptyResult()
    const uniquePaths = [...new Set(paths.map((value) => value.trim()).filter(Boolean))].slice(
      0,
      MAX_DROP_ITEMS
    )
    if (uniquePaths.length === 0) {
      result.ok = false
      result.errors.push({
        code: 'unsupported',
        message: '没有收到可暂存的文件。'
      })
      return result
    }
    if (this.activeCount() >= MAX_ITEMS_TOTAL) {
      result.ok = false
      result.errors.push({
        code: 'quota',
        message: `暂存台已达到 ${MAX_ITEMS_TOTAL} 项上限，请先清理一些内容。`
      })
      return result
    }
    await this.ensureLayout()
    for (const path of uniquePaths) {
      try {
        const outcome = await this.insertFileLike(path, options)
        if (outcome.added) result.added += 1
        if (outcome.duplicate) result.duplicates += 1
      } catch (error) {
        const detail =
          error instanceof KnownItemError
            ? error.detail
            : errorFromUnknown(error, basename(path))
        result.errors.push(detail)
        logger.warn('items.add_path_failed', { code: detail.code })
      }
    }
    result.ok = result.added > 0 || result.duplicates > 0
    if (result.added > 0 || result.duplicates > 0) this.emit()
    return result
  }

  private insertRow(row: ItemRow): void {
    this.db.run(
      `INSERT INTO items (
        id, type, name, ref_path, stored_rel, thumb_rel, storage_mode,
        text_content, html_content, url, size, source_app, source,
        created_at, updated_at, expires_at, pinned, pinned_at, status,
        hash, identity, sort_order, deleted_at, last_checked_at, moved_in,
        original_path, meta
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.type,
      row.name,
      row.ref_path,
      row.stored_rel,
      row.thumb_rel,
      row.storage_mode,
      row.text_content,
      row.html_content,
      row.url,
      row.size,
      row.source_app,
      row.source,
      row.created_at,
      row.updated_at,
      row.expires_at,
      row.pinned,
      row.pinned_at,
      row.status,
      row.hash,
      row.identity,
      row.sort_order,
      row.deleted_at,
      row.last_checked_at,
      row.moved_in,
      row.original_path,
      row.meta
    )
  }

  private async createThumbnail(
    id: string,
    absolutePath: string,
    type: ItemType
  ): Promise<string | null> {
    // Only real image previews are stored. File-type badges are rendered by the UI,
    // which keeps the shelf visually consistent and avoids icon-cache surprises.
    if (type !== 'image') return null
    try {
      await ensureDir(this.thumbsRoot())
      let image = null
      try {
        image = await nativeImage.createThumbnailFromPath(absolutePath, {
          width: 360,
          height: 360
        })
      } catch {
        image = null
      }
      if (!image || image.isEmpty()) return null
      const png = image.toPNG()
      if (png.length === 0) return null
      const relativePath = toRelative(this.storageRoot(), join(this.thumbsRoot(), `${id}.png`))
      await fs.writeFile(join(this.storageRoot(), relativePath), png)
      return relativePath
    } catch (error) {
      logger.debug('items.thumbnail_failed', { id, error })
      return null
    }
  }

  async addText(input: AddTextInput): Promise<MutationResult> {
    const settings = this.settings.get()
    const result = emptyResult()
    const raw = (input.text ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n')
    const text = raw.replace(/^\uFEFF/, '')
    if (!text.trim()) {
      result.ok = false
      result.errors.push({ code: 'invalid', message: '文本内容为空，未添加。' })
      return result
    }
    if (text.length > MAX_TEXT_CHARS) {
      result.ok = false
      result.errors.push({
        code: 'too_large',
        message: `文本超过 ${(MAX_TEXT_CHARS / 10000).toFixed(0)} 万字，暂不支持。`
      })
      return result
    }
    if (this.activeCount() >= MAX_ITEMS_TOTAL) {
      result.ok = false
      result.errors.push({ code: 'quota', message: '暂存台已满，请先清理一些内容。' })
      return result
    }

    const normalizedUrl = text.trim().length <= 4096 && !text.includes('\n') ? normalizeUrl(text) : null
    const type: ItemType = normalizedUrl ? 'url' : 'text'
    const identity = normalizedUrl ? `url:${normalizedUrl}` : `text:${hashText(text)}`
    const duplicate = this.findDuplicate(identity)
    if (duplicate) {
      this.touchDuplicate(duplicate, cleanSourceApp(input.sourceApp))
      result.duplicates = 1
      this.emit()
      return result
    }

    const now = Date.now()
    const html =
      !normalizedUrl && input.html && input.html.length <= 1_000_000 ? input.html : null
    const name = normalizedUrl ? nameForUrl(normalizedUrl) : titleForText(text)
    const size = Buffer.byteLength(text, 'utf8')
    const row: ItemRow = {
      id: createId('it_'),
      type,
      name,
      ref_path: null,
      stored_rel: null,
      thumb_rel: null,
      storage_mode: 'reference',
      text_content: text,
      html_content: html,
      url: normalizedUrl,
      size,
      source_app: cleanSourceApp(input.sourceApp),
      source: input.source ?? 'manual',
      created_at: now,
      updated_at: now,
      expires_at: computeExpiresAt(settings.defaultTtl, now),
      pinned: 0,
      pinned_at: null,
      status: 'active',
      hash: normalizedUrl ? null : hashText(text),
      identity,
      sort_order: now + 2000,
      deleted_at: null,
      last_checked_at: now,
      moved_in: 0,
      original_path: null,
      meta: JSON.stringify({ languageHint: null })
    }
    this.insertRow(row)
    result.added = 1
    this.emit()
    return result
  }

  async addUrls(
    urls: string[],
    options: { sourceApp?: string | null; source?: ItemSource } = {}
  ): Promise<MutationResult> {
    const result = emptyResult()
    const settings = this.settings.get()
    const seen = new Set<string>()
    let index = 0
    for (const raw of urls.slice(0, 20)) {
      const url = normalizeUrl(raw)
      if (!url || seen.has(url)) continue
      seen.add(url)
      const identity = `url:${url}`
      const duplicate = this.findDuplicate(identity)
      if (duplicate) {
        this.touchDuplicate(duplicate, cleanSourceApp(options.sourceApp))
        result.duplicates += 1
        continue
      }
      if (this.activeCount() >= MAX_ITEMS_TOTAL) {
        result.errors.push({ code: 'quota', message: '暂存台已满，请先清理一些内容。' })
        break
      }
      const now = Date.now()
      const row: ItemRow = {
        id: createId('it_'),
        type: 'url',
        name: nameForUrl(url),
        ref_path: null,
        stored_rel: null,
        thumb_rel: null,
        storage_mode: 'reference',
        text_content: url,
        html_content: null,
        url,
        size: Buffer.byteLength(url, 'utf8'),
        source_app: cleanSourceApp(options.sourceApp),
        source: options.source ?? 'manual',
        created_at: now,
        updated_at: now,
        expires_at: computeExpiresAt(settings.defaultTtl, now),
        pinned: 0,
        pinned_at: null,
        status: 'active',
        hash: null,
        identity,
        sort_order: now + 1800 - index,
        deleted_at: null,
        last_checked_at: now,
        moved_in: 0,
        original_path: null,
        meta: null
      }
      index += 1
      this.insertRow(row)
      result.added += 1
    }
    if (result.added > 0 || result.duplicates > 0) this.emit()
    return result
  }

  async addImageBuffer(
    buffer: Buffer,
    input: { name?: string; sourceApp?: string | null; source?: ItemSource; mime?: string }
  ): Promise<MutationResult> {
    const settings = this.settings.get()
    const result = emptyResult()
    if (buffer.length === 0) {
      result.ok = false
      result.errors.push({ code: 'invalid', message: '图片内容为空，未添加。' })
      return result
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      result.ok = false
      result.errors.push({ code: 'too_large', message: '图片超过 64 MB，暂不支持。' })
      return result
    }
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) {
      result.ok = false
      result.errors.push({ code: 'unsupported', message: '无法识别这张图片。' })
      return result
    }
    const png = image.toPNG()
    const hash = hashBuffer(png)
    const identity = `image:${hash}`
    const duplicate = this.findDuplicate(identity)
    if (duplicate) {
      this.touchDuplicate(duplicate, cleanSourceApp(input.sourceApp))
      result.duplicates = 1
      this.emit()
      return result
    }
    if (this.activeCount() >= MAX_ITEMS_TOTAL) {
      result.ok = false
      result.errors.push({ code: 'quota', message: '暂存台已满，请先清理一些内容。' })
      return result
    }
    const size = png.length
    const capacity = settings.capacityMb * MB
    if (capacity > 0 && this.usage().storedBytes + size > capacity) {
      result.ok = false
      result.errors.push({
        code: 'quota',
        message: `容量不足：图片需要 ${formatBytes(size)}，请调整上限或清理内容。`
      })
      return result
    }
    await this.ensureLayout()
    const now = Date.now()
    const id = createId('it_')
    const stamp = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
      .format(now)
      .replace(/[/:]/g, '-')
    const safeName = sanitizeFileName(input.name || `剪贴板图片 ${stamp}.png`, '图片.png')
    const fileName = safeName.toLowerCase().endsWith('.png') ? safeName : `${safeName}.png`
    const directory = join(this.filesRoot(), id)
    const destination = await uniqueDestination(directory, fileName)
    try {
      await ensureDir(directory)
      await fs.writeFile(destination, png)
    } catch (error) {
      await removePath(directory)
      result.ok = false
      result.errors.push(errorFromUnknown(error, fileName))
      return result
    }
    const storedRel = toRelative(this.storageRoot(), destination)
    const thumbRel = await this.createThumbnail(id, destination, 'image')
    const dimensions = image.getSize()
    const row: ItemRow = {
      id,
      type: 'image',
      name: fileName,
      ref_path: null,
      stored_rel: storedRel,
      thumb_rel: thumbRel,
      storage_mode: 'copy',
      text_content: null,
      html_content: null,
      url: null,
      size,
      source_app: cleanSourceApp(input.sourceApp),
      source: input.source ?? 'clipboard',
      created_at: now,
      updated_at: now,
      expires_at: computeExpiresAt(settings.defaultTtl, now),
      pinned: 0,
      pinned_at: null,
      status: 'active',
      hash,
      identity,
      sort_order: now + 2000,
      deleted_at: null,
      last_checked_at: now,
      moved_in: 0,
      original_path: null,
      meta: JSON.stringify({ width: dimensions.width, height: dimensions.height })
    }
    this.insertRow(row)
    result.added = 1
    this.emit()
    return result
  }

  async update(id: string, patch: { pinned?: boolean; name?: string }): Promise<MutationResult> {
    const row = this.rowById(id)
    const result = emptyResult()
    if (!row || (row.status !== 'active' && row.status !== 'missing')) {
      result.ok = false
      result.errors.push({ code: 'not_found', message: '这条内容已不在暂存台中。' })
      return result
    }
    const now = Date.now()
    let expiresAt = row.expires_at
    let pinned = row.pinned
    let pinnedAt = row.pinned_at
    if (typeof patch.pinned === 'boolean') {
      pinned = patch.pinned ? 1 : 0
      pinnedAt = patch.pinned ? now : null
      expiresAt = patch.pinned
        ? null
        : computeExpiresAt(this.settings.get().defaultTtl, now)
    }
    const name =
      typeof patch.name === 'string' && patch.name.trim()
        ? sanitizeFileName(patch.name.trim(), row.name).slice(0, 120)
        : row.name
    this.db.run(
      'UPDATE items SET pinned = ?, pinned_at = ?, expires_at = ?, name = ?, updated_at = ? WHERE id = ?',
      pinned,
      pinnedAt,
      expiresAt,
      name,
      now,
      id
    )
    this.emit()
    return result
  }

  async remove(ids: string[]): Promise<MutationResult> {
    const unique = [...new Set(ids)].filter(Boolean)
    const result = emptyResult()
    if (unique.length === 0) return result
    const placeholders = unique.map(() => '?').join(',')
    const now = Date.now()
    this.db.run(
      `UPDATE items SET status = 'deleted', deleted_at = ?, updated_at = ?
       WHERE id IN (${placeholders}) AND status IN ('active', 'missing')`,
      now,
      now,
      ...unique
    )
    this.emit()
    return result
  }

  async setPinned(ids: string[], pinned: boolean): Promise<MutationResult> {
    const result = emptyResult()
    const rows = ids
      .map((id) => this.rowById(id))
      .filter(
        (row): row is ItemRow =>
          Boolean(row) && (row!.status === 'active' || row!.status === 'missing')
      )
    if (rows.length === 0) {
      result.ok = false
      result.errors.push({ code: 'not_found', message: '没有可固定的内容。' })
      return result
    }
    const now = Date.now()
    const ttl = this.settings.get().defaultTtl
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run(
          'UPDATE items SET pinned = ?, pinned_at = ?, expires_at = ?, updated_at = ? WHERE id = ?',
          pinned ? 1 : 0,
          pinned ? now : null,
          pinned ? null : computeExpiresAt(ttl, now),
          now,
          row.id
        )
      }
    })
    this.emit()
    return result
  }

  async markMovedOut(ids: string[]): Promise<number> {
    const rows = this.getFileLikeRows(ids)
    let removed = 0
    const now = Date.now()
    for (const row of rows) {
      const absolute = this.resolveItemPath(row)
      if (absolute && !pathExists(absolute)) {
        this.db.run(
          "UPDATE items SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?",
          now,
          now,
          row.id
        )
        removed += 1
      }
    }
    if (removed > 0) this.emit()
    return removed
  }

  async clear(includePinned: boolean): Promise<{ result: MutationResult; ids: string[] }> {
    const rows = this.db.all<ItemRow>(
      `SELECT * FROM items WHERE status IN ('active', 'missing') ${
        includePinned ? '' : 'AND pinned = 0'
      }`
    )
    const result = emptyResult()
    if (rows.length === 0) {
      result.ok = false
      result.message = includePinned ? '暂存台已经是空的。' : '没有可清理的临时项。'
      return { result, ids: [] }
    }
    const now = Date.now()
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run(
          "UPDATE items SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?",
          now,
          now,
          row.id
        )
      }
    })
    this.emit()
    return { result, ids: rows.map((row) => row.id) }
  }

  async restore(ids: string[], extendExpiry: boolean): Promise<number> {
    let restored = 0
    const now = Date.now()
    const ttl = this.settings.get().defaultTtl
    for (const id of ids) {
      const row = this.rowById(id)
      if (!row || (row.status !== 'deleted' && row.status !== 'expired')) continue
      const stillExists = this.rowStillExists(row)
      const expiresAt =
        row.pinned === 1
          ? null
          : extendExpiry || row.expires_at == null || row.expires_at <= now
            ? computeExpiresAt(ttl, now)
            : row.expires_at
      this.db.run(
        'UPDATE items SET status = ?, deleted_at = NULL, updated_at = ?, expires_at = ? WHERE id = ?',
        stillExists ? 'active' : 'missing',
        now,
        expiresAt,
        id
      )
      restored += 1
    }
    if (restored > 0) this.emit()
    return restored
  }

  private rowStillExists(row: ItemRow): boolean {
    if (row.type === 'text' || row.type === 'url') return true
    const absolute = this.resolveItemPath(row)
    return absolute ? pathExists(absolute) : false
  }

  resolveItemPath(row: ItemRow): string | null {
    if (row.stored_rel) {
      return resolveUnder(this.storageRoot(), row.stored_rel)
    }
    return row.ref_path
  }

  async restoreOriginal(id: string): Promise<MutationResult> {
    const row = this.rowById(id)
    const result = emptyResult()
    if (!row || row.status !== 'active') {
      result.ok = false
      result.errors.push({ code: 'not_found', message: '这条内容已不在暂存台中。' })
      return result
    }
    if (!row.moved_in || !row.original_path || !row.stored_rel) {
      result.ok = false
      result.errors.push({ code: 'invalid', message: '这条内容不是剪切移入的，无法放回原处。' })
      return result
    }
    const stored = this.resolveItemPath(row)
    if (!stored || !pathExists(stored)) {
      result.ok = false
      result.errors.push({ code: 'not_found', message: '暂存副本已丢失，无法放回原处。' })
      return result
    }
    if (pathExists(row.original_path)) {
      result.ok = false
      result.errors.push({
        code: 'invalid',
        message: '原位置已存在同名文件，请先移动它，或改用拖出。'
      })
      return result
    }
    if (!pathExists(dirname(row.original_path))) {
      result.ok = false
      result.errors.push({ code: 'not_found', message: '原位置所在文件夹已不存在，无法放回。' })
      return result
    }
    try {
      await movePath(stored, row.original_path, row.type === 'folder')
      const now = Date.now()
      this.db.run(
        `UPDATE items SET ref_path = ?, stored_rel = NULL, storage_mode = 'reference',
         moved_in = 0, original_path = ?, status = 'active', updated_at = ? WHERE id = ?`,
        row.original_path,
        row.original_path,
        now,
        id
      )
      await removePath(join(this.filesRoot(), id))
      result.message = '已放回原位置。'
      this.emit()
      return result
    } catch (error) {
      result.ok = false
      result.errors.push(errorFromUnknown(error, row.name))
      return result
    }
  }

  async relocate(id: string, newPath: string): Promise<MutationResult> {
    const row = this.rowById(id)
    const result = emptyResult()
    if (!row || (row.status !== 'active' && row.status !== 'missing')) {
      result.ok = false
      result.errors.push({ code: 'not_found', message: '这条内容已不在暂存台中。' })
      return result
    }
    if (row.type === 'text' || row.type === 'url') {
      result.ok = false
      result.errors.push({ code: 'invalid', message: '文本和链接无需重新定位。' })
      return result
    }
    try {
      const stat = await fs.stat(newPath)
      if (row.type === 'folder' && !stat.isDirectory()) {
        result.ok = false
        result.errors.push({ code: 'invalid', message: '请选择一个文件夹。' })
        return result
      }
      if (row.type !== 'folder' && !stat.isFile()) {
        result.ok = false
        result.errors.push({ code: 'invalid', message: '请选择一个文件。' })
        return result
      }
      const now = Date.now()
      this.db.run(
        `UPDATE items SET ref_path = ?, stored_rel = NULL, storage_mode = 'reference',
         moved_in = 0, original_path = ?, status = 'active', size = ?, name = ?,
         last_checked_at = ?, updated_at = ? WHERE id = ?`,
        newPath,
        newPath,
        stat.size,
        basename(newPath),
        now,
        now,
        id
      )
      if (row.stored_rel) await removePath(join(this.filesRoot(), id))
      if (row.thumb_rel) {
        const thumb = resolveUnder(this.storageRoot(), row.thumb_rel)
        if (thumb) await removePath(thumb)
      }
      const thumbRel = await this.createThumbnail(id, newPath, row.type)
      this.db.run('UPDATE items SET thumb_rel = ? WHERE id = ?', thumbRel, id)
      result.message = '已重新定位。'
      this.emit()
      return result
    } catch (error) {
      result.ok = false
      result.errors.push(errorFromUnknown(error, row.name))
      return result
    }
  }

  async verify(): Promise<{ missing: number; recovered: number }> {
    let missing = 0
    let recovered = 0
    const rows = this.db.all<ItemRow>(
      "SELECT * FROM items WHERE status IN ('active', 'missing') AND type IN ('file', 'folder', 'image')"
    )
    const now = Date.now()
    for (const row of rows) {
      const absolute = this.resolveItemPath(row)
      let exists = false
      if (absolute) {
        try {
          await fs.access(absolute)
          exists = true
        } catch {
          exists = false
        }
      }
      if (!exists && row.status === 'active') {
        this.db.run("UPDATE items SET status = 'missing', last_checked_at = ? WHERE id = ?", now, row.id)
        missing += 1
      } else if (exists && row.status === 'missing') {
        this.db.run("UPDATE items SET status = 'active', last_checked_at = ? WHERE id = ?", now, row.id)
        recovered += 1
      } else {
        this.db.run('UPDATE items SET last_checked_at = ? WHERE id = ?', now, row.id)
      }
    }
    if (missing > 0 || recovered > 0) this.emit()
    return { missing, recovered }
  }

  async sweepExpired(now = Date.now()): Promise<{ expired: number; ids: string[]; remind: number }> {
    const rows = this.db.all<ItemRow>(
      `SELECT * FROM items WHERE status IN ('active', 'missing') AND pinned = 0
       AND expires_at IS NOT NULL AND expires_at <= ?`,
      now
    )
    const ids: string[] = []
    if (rows.length > 0) {
      this.db.transaction(() => {
        for (const row of rows) {
          this.db.run(
            "UPDATE items SET status = 'expired', deleted_at = ?, updated_at = ? WHERE id = ?",
            now,
            now,
            row.id
          )
          ids.push(row.id)
        }
      })
      this.emit()
    }

    const soon = this.db.all<ItemRow>(
      `SELECT * FROM items WHERE status IN ('active', 'missing') AND pinned = 0
       AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?`,
      now,
      now + EXPIRY_REMINDER_MS
    )
    let remind = 0
    for (const row of soon) {
      if (this.notifiedReminders.has(row.id)) continue
      this.notifiedReminders.add(row.id)
      remind += 1
    }
    if (this.notifiedReminders.size > 500) {
      this.notifiedReminders = new Set([...this.notifiedReminders].slice(-200))
    }
    return { expired: rows.length, ids, remind }
  }

  async purgeTrash(olderThan: number): Promise<number> {
    const rows = this.db.all<ItemRow>(
      "SELECT * FROM items WHERE status IN ('deleted', 'expired') AND deleted_at IS NOT NULL AND deleted_at < ?",
      olderThan
    )
    let purged = 0
    for (const row of rows) {
      try {
        if (row.stored_rel) {
          await removePath(join(this.filesRoot(), row.id))
        }
        if (row.thumb_rel) {
          const thumb = resolveUnder(this.storageRoot(), row.thumb_rel)
          if (thumb) await removePath(thumb)
        }
        this.db.run('DELETE FROM items WHERE id = ?', row.id)
        this.notifiedReminders.delete(row.id)
        purged += 1
      } catch (error) {
        logger.warn('items.purge_failed', { id: row.id, error })
      }
    }
    if (purged > 0) this.emit()
    return purged
  }

  usage(): StorageUsage {
    const settings = this.settings.get()
    const stored = this.db.get<{ total: number | null }>(
      'SELECT SUM(size) AS total FROM items WHERE stored_rel IS NOT NULL'
    )
    const referenced = this.db.get<{ total: number | null }>(
      `SELECT SUM(size) AS total FROM items WHERE stored_rel IS NULL
       AND type IN ('file', 'folder', 'image') AND status IN ('active', 'missing')`
    )
    const counts = this.db.get<{
      items: number
      pinned: number
      missing: number
    }>(
      `SELECT COUNT(*) AS items,
       SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) AS pinned,
       SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END) AS missing
       FROM items WHERE status IN ('active', 'missing')`
    )
    return {
      storedBytes: stored?.total ?? 0,
      referencedBytes: referenced?.total ?? 0,
      capacityBytes: settings.capacityMb * MB,
      itemCount: counts?.items ?? 0,
      pinnedCount: counts?.pinned ?? 0,
      missingCount: counts?.missing ?? 0
    }
  }

  getView(row: ItemRow, now = Date.now()): ShelfItemView {
    const absolute = this.resolveItemPath(row)
    const ext = row.type === 'text' || row.type === 'url' ? null : fileExtension(row.name)
    const thumbUrl = row.thumb_rel
      ? `flowtray://thumb/${encodeURIComponent(row.id)}?v=${row.updated_at}`
      : null
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      preview:
        row.type === 'text' && row.text_content ? previewForText(row.text_content) : null,
      textContent:
        row.type === 'text' || row.type === 'url' ? row.text_content : null,
      textLength: row.type === 'text' && row.text_content ? row.text_content.length : null,
      url: row.url,
      path: absolute,
      ext,
      size: row.size,
      sourceApp: row.source_app,
      source: row.source,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      pinned: row.pinned === 1,
      status: row.status,
      storageMode: row.storage_mode,
      hasThumb: Boolean(row.thumb_rel),
      thumbUrl,
      movedIn: row.moved_in === 1,
      expiresInMs: row.expires_at == null ? null : Math.max(0, row.expires_at - now),
      expiringSoon:
        row.pinned === 0 &&
        row.expires_at != null &&
        row.expires_at - now <= EXPIRY_REMINDER_MS &&
        row.expires_at > now
    }
  }

  getItems(now = Date.now()): ShelfItemView[] {
    return this.listRows().map((row) => this.getView(row, now))
  }

  getDetail(id: string): ShelfItemDetail | null {
    const row = this.rowById(id)
    if (!row || (row.status !== 'active' && row.status !== 'missing')) return null
    const view = this.getView(row)
    let meta: Record<string, unknown> | null = null
    if (row.meta) {
      try {
        meta = JSON.parse(row.meta) as Record<string, unknown>
      } catch {
        meta = null
      }
    }
    return {
      ...view,
      textContent: row.text_content,
      htmlContent: row.html_content,
      originalPath: row.original_path,
      hash: row.hash,
      lastCheckedAt: row.last_checked_at,
      meta
    }
  }

  getThumbPath(id: string): string | null {
    const row = this.rowById(id)
    if (!row || !row.thumb_rel) return null
    const absolute = resolveUnder(this.storageRoot(), row.thumb_rel)
    if (!absolute || !pathExists(absolute)) return null
    return absolute
  }

  getItem(id: string): ItemRow | undefined {
    return this.rowById(id)
  }

  getCopyableRows(ids: string[]): ItemRow[] {
    return ids
      .map((id) => this.rowById(id))
      .filter((row): row is ItemRow => Boolean(row))
      .filter((row) => row.status === 'active' || row.status === 'missing')
  }

  getFileLikeRows(ids: string[]): ItemRow[] {
    return this.getCopyableRows(ids).filter(
      (row) => row.type === 'file' || row.type === 'folder' || row.type === 'image'
    )
  }

  getExistingPaths(rows: ItemRow[]): { paths: string[]; errors: ItemError[] } {
    const paths: string[] = []
    const errors: ItemError[] = []
    for (const row of rows) {
      const absolute = this.resolveItemPath(row)
      if (!absolute || !pathExists(absolute)) {
        errors.push({
          code: 'not_found',
          message: `「${row.name}」已失效，请重新定位后再试。`,
          name: row.name
        })
        continue
      }
      paths.push(absolute)
    }
    return { paths, errors }
  }

  async enforceClipboardLimit(max: number): Promise<number> {
    const rows = this.db.all<ItemRow>(
      `SELECT * FROM items WHERE status = 'active' AND source = 'clipboard'
       ORDER BY created_at ASC`
    )
    const excess = rows.length - max
    if (excess <= 0) return 0
    let removed = 0
    const now = Date.now()
    for (const row of rows) {
      if (removed >= excess) break
      if (row.pinned === 1) continue
      this.db.run(
        "UPDATE items SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?",
        now,
        now,
        row.id
      )
      removed += 1
    }
    if (removed > 0) this.emit()
    return removed
  }

  isInsideStorage(target: string): boolean {
    return isPathInside(target, this.storageRoot())
  }

  storagePath(): string {
    return this.storageRoot()
  }

  thumbsPath(): string {
    return this.thumbsRoot()
  }

  filesPath(): string {
    return this.filesRoot()
  }

  getStorageLayoutForTests(): { storage: string; files: string; thumbs: string } {
    return {
      storage: this.storageRoot(),
      files: this.filesRoot(),
      thumbs: this.thumbsRoot()
    }
  }
}
