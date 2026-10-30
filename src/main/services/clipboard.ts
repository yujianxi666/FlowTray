import { clipboard, ClipboardItem } from 'electron'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { MAX_IMAGE_BYTES, MAX_TEXT_CHARS } from '@shared/constants'
import { isSensitiveSource } from '@shared/settings'
import type { MutationResult } from '@shared/types'
import { logger } from '@main/lib/logger'
import { foreground } from '@main/services/foreground'
import type { ItemService } from '@main/services/items'
import type { SettingsStore } from '@main/store/settings'

interface ClipboardRaw {
  types: string[]
  text: string
  html: string
  uriList: string
  files: string[]
  links: string[]
  bookmark: { title: string; url: string } | null
  image: Blob | null
  imageSize: number
  imageSampleHash: string
  fingerprint: string
}

function emptyResult(): MutationResult {
  return { ok: false, added: 0, duplicates: 0, errors: [] }
}

function hashHex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

async function blobOrString(value: unknown): Promise<string> {
  if (typeof value === 'string') return value
  if (value instanceof Blob) return await value.text()
  return ''
}

async function blobSampleHash(blob: Blob): Promise<string> {
  const head = Buffer.from(await blob.slice(0, 8192).arrayBuffer())
  const tail =
    blob.size > 8192
      ? Buffer.from(await blob.slice(Math.max(0, blob.size - 8192)).arrayBuffer())
      : Buffer.alloc(0)
  return hashHex(Buffer.concat([Buffer.from(String(blob.size)), head, tail]))
}

function parseUriList(value: string): { files: string[]; links: string[] } {
  const files: string[] = []
  const links: string[] = []
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    try {
      const url = new URL(line)
      if (url.protocol === 'file:') {
        const filePath = fileURLToPath(url)
        if (filePath) files.push(filePath)
      } else if (url.protocol === 'http:' || url.protocol === 'https:') {
        links.push(url.href)
      }
    } catch {
      // Ignore malformed URI entries.
    }
  }
  return { files, links }
}

function normalizeFileNameList(value: string): string[] {
  const cleaned = value.replace(/^\uFEFF/, '')
  const parts = cleaned.includes('\u0000') ? cleaned.split('\u0000') : cleaned.split(/\r?\n/)
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && /^[A-Za-z]:\\|^\\\\/.test(part))
}

export class ClipboardService {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private lastFingerprint = ''
  private suppressUntil = 0
  private lastSkippedSensitive = 0

  constructor(
    private readonly items: ItemService,
    private readonly settings: SettingsStore
  ) {}

  get isMonitoring(): boolean {
    return this.timer != null
  }

  async startMonitoring(): Promise<void> {
    if (this.timer) return
    await this.refreshBaseline()
    this.timer = setInterval(() => {
      void this.tick()
    }, 700)
    logger.info('clipboard.monitor_started')
  }

  stopMonitoring(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      logger.info('clipboard.monitor_stopped')
    }
  }

  private async tick(): Promise<void> {
    if (this.busy || Date.now() < this.suppressUntil) return
    this.busy = true
    try {
      const raw = await this.readRaw()
      if (!raw || raw.fingerprint === this.lastFingerprint) return
      this.lastFingerprint = raw.fingerprint
      if (!this.hasContent(raw)) return

      const info = await foreground.get()
      if (!info) {
        logger.debug('clipboard.skipped_unknown_foreground')
        return
      }
      if (this.isOwnProcess(info.processName)) return
      const settings = this.settings.get()
      if (isSensitiveSource(info, settings.sensitiveApps, settings.sensitiveTitles)) {
        this.lastSkippedSensitive = Date.now()
        logger.info('clipboard.skipped_sensitive_app', { app: info.appName })
        return
      }
      await this.ingest(raw, info.appName, false)
      await this.items.enforceClipboardLimit(settings.clipboardMaxItems)
    } catch (error) {
      logger.debug('clipboard.tick_failed', { error })
    } finally {
      this.busy = false
    }
  }

  private isOwnProcess(processName: string): boolean {
    const lower = processName.toLowerCase()
    return lower.includes('flowtray') || lower === 'electron'
  }

  private hasContent(raw: ClipboardRaw): boolean {
    return (
      raw.files.length > 0 ||
      raw.links.length > 0 ||
      Boolean(raw.bookmark) ||
      Boolean(raw.image) ||
      raw.text.trim().length > 0
    )
  }

  async readRaw(): Promise<ClipboardRaw | null> {
    try {
      const items = await clipboard.read()
      const raw: ClipboardRaw = {
        types: [],
        text: '',
        html: '',
        uriList: '',
        files: [],
        links: [],
        bookmark: null,
        image: null,
        imageSize: 0,
        imageSampleHash: '',
        fingerprint: ''
      }
      for (const item of items) {
        for (const type of item.types) {
          raw.types.push(type)
          try {
            const value = await item.getType(type)
            if (type === 'text/plain' && !raw.text) {
              raw.text = await blobOrString(value)
            } else if (type === 'text/html' && !raw.html) {
              raw.html = await blobOrString(value)
            } else if (type === 'text/uri-list' && !raw.uriList) {
              raw.uriList = await blobOrString(value)
            } else if (type === 'electron application/bookmark' && value && typeof value === 'object') {
              const bookmark = value as { title?: string; url?: string }
              if (bookmark.url) {
                raw.bookmark = { title: bookmark.title ?? '', url: bookmark.url }
              }
            } else if (type.startsWith('image/') && value instanceof Blob) {
              if (!raw.image || type === 'image/png') {
                raw.image = value
                raw.imageSize = value.size
                raw.imageSampleHash = await blobSampleHash(value)
              }
            } else if (
              type.toLowerCase().includes('osclipboard;format="filename') &&
              value instanceof Blob
            ) {
              const buffer = Buffer.from(await value.arrayBuffer())
              const decoded = buffer.toString('utf8')
              const names = normalizeFileNameList(decoded)
              if (names.length > 0) {
                raw.files.push(...names)
              } else {
                const wide = buffer.toString('utf16le')
                raw.files.push(...normalizeFileNameList(wide))
              }
            }
          } catch {
            // A single unreadable format should not discard the rest.
          }
        }
      }
      if (raw.uriList) {
        const parsed = parseUriList(raw.uriList)
        raw.files.push(...parsed.files)
        raw.links.push(...parsed.links)
      }
      raw.files = [...new Set(raw.files)]
      raw.links = [...new Set(raw.links)]
      const fingerprint = hashHex(
        JSON.stringify({
          types: raw.types.sort(),
          text: raw.text,
          html: raw.html,
          uriList: raw.uriList,
          files: raw.files,
          links: raw.links,
          bookmark: raw.bookmark,
          imageSize: raw.imageSize,
          imageSampleHash: raw.imageSampleHash
        })
      )
      raw.fingerprint = fingerprint
      return raw
    } catch (error) {
      logger.debug('clipboard.read_failed', { error })
      return null
    }
  }

  private async ingest(
    raw: ClipboardRaw,
    sourceApp: string | null,
    explicit: boolean
  ): Promise<MutationResult> {
    const result = emptyResult()
    const source = 'clipboard' as const
    try {
      if (raw.files.length > 0) {
        const outcome = await this.items.addPaths(raw.files, {
          sourceApp,
          source,
          effect: 'copy'
        })
        return outcome
      }
      if (raw.links.length > 0) {
        const outcome = await this.items.addUrls(raw.links, { sourceApp, source })
        return outcome
      }
      if (raw.image) {
        const textLooksEmpty = raw.text.trim().length === 0
        if (textLooksEmpty || explicit) {
          if (raw.image.size > MAX_IMAGE_BYTES) {
            result.errors.push({ code: 'too_large', message: '剪贴板图片超过 64 MB，未收录。' })
            return result
          }
          const buffer = Buffer.from(await raw.image.arrayBuffer())
          return await this.items.addImageBuffer(buffer, { sourceApp, source })
        }
      }
      if (raw.bookmark?.url && !raw.text.trim()) {
        return await this.items.addUrls([raw.bookmark.url], { sourceApp, source })
      }
      if (raw.text.trim()) {
        if (raw.text.length > MAX_TEXT_CHARS) {
          result.errors.push({ code: 'too_large', message: '剪贴板文本过大，未收录。' })
          return result
        }
        const html = raw.html && raw.html.length <= 1_000_000 ? raw.html : null
        return await this.items.addText({
          text: raw.text,
          html,
          sourceApp,
          source
        })
      }
      result.errors.push({ code: 'clipboard_empty', message: '剪贴板里没有可暂存的内容。' })
      return result
    } catch (error) {
      logger.warn('clipboard.ingest_failed', { error })
      result.errors.push({ code: 'unknown', message: '读取剪贴板内容失败，请稍后重试。' })
      return result
    }
  }

  async captureExplicit(options: { sourceFromForeground: boolean }): Promise<MutationResult> {
    const raw = await this.readRaw()
    if (!raw || !this.hasContent(raw)) {
      const result = emptyResult()
      result.errors.push({ code: 'clipboard_empty', message: '剪贴板里没有可暂存的内容。' })
      return result
    }
    let sourceApp: string | null = null
    if (options.sourceFromForeground) {
      const info = await foreground.get({ bypassCache: true })
      if (info) {
        const settings = this.settings.get()
        if (isSensitiveSource(info, settings.sensitiveApps, settings.sensitiveTitles)) {
          const result = emptyResult()
          result.errors.push({
            code: 'sensitive',
            message: `当前应用「${info.appName}」在隐私排除列表中，未收录剪贴板内容。`
          })
          logger.info('clipboard.explicit_sensitive_skip', { app: info.appName })
          return result
        }
        sourceApp = info.appName
      }
    }
    const result = await this.ingest(raw, sourceApp, true)
    if (result.ok) {
      await this.items.enforceClipboardLimit(this.settings.get().clipboardMaxItems)
      this.lastFingerprint = raw.fingerprint
      this.suppressUntil = Date.now() + 600
    }
    return result
  }

  private async refreshBaseline(): Promise<void> {
    const raw = await this.readRaw()
    if (raw) this.lastFingerprint = raw.fingerprint
  }

  async markSelfWrite(): Promise<void> {
    this.suppressUntil = Date.now() + 1400
    setTimeout(() => {
      void this.refreshBaseline()
    }, 300)
  }

  async copyText(text: string, html?: string | null): Promise<void> {
    const itemData: Record<string, string | Blob> = {
      'text/plain': text
    }
    if (html && html.trim()) itemData['text/html'] = html
    await clipboard.write([new ClipboardItem(itemData)])
    await this.markSelfWrite()
  }

  async copyImage(png: Buffer): Promise<void> {
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' })
      })
    ])
    await this.markSelfWrite()
  }

  async copyFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) throw new Error('no files to copy')
    const uriList = paths.map((file) => pathToFileURL(file).toString()).join('\r\n')
    const plain = paths.join('\r\n')
    const html = paths
      .map((file) => {
        const url = pathToFileURL(file).toString()
        return `<a href="${url.replace(/"/g, '&quot;')}">${path.basename(file)}</a>`
      })
      .join('<br>')
    await clipboard.write([
      new ClipboardItem({
        'text/plain': plain,
        'text/html': html,
        'text/uri-list': uriList
      })
    ])
    await this.markSelfWrite()
  }

  async copyBookmark(url: string, text: string): Promise<void> {
    // A URL card is most useful as a normal link, not as a bookmark-only item.
    await this.copyText(text || url, `<a href="${url.replace(/"/g, '&quot;')}">${url}</a>`)
  }

  lastSensitiveSkipAt(): number {
    return this.lastSkippedSensitive
  }
}
