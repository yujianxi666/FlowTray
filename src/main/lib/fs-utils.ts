import { createHash } from 'node:crypto'
import {
  constants as fsConstants,
  mkdirSync,
  promises as fs,
  existsSync,
  statSync
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
  '.avif',
  '.tif',
  '.tiff'
])

const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

export function ensureDirSync(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
  }
}

export async function ensureDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true })
}

export function pathExists(target: string): boolean {
  try {
    return existsSync(target)
  } catch {
    return false
  }
}

export function isImagePath(target: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(target).toLowerCase())
}

export function sanitizeFileName(input: string, fallback = '未命名'): string {
  let name = (input || '').normalize('NFC')
  name = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()
  name = name.replace(/[. ]+$/g, '')
  if (!name) name = fallback
  const ext = extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  const safeBase = RESERVED_NAMES.has(base.toLowerCase()) ? `${base}_` : base
  const maxBase = Math.max(8, 110 - ext.length)
  const clipped = safeBase.length > maxBase ? safeBase.slice(0, maxBase) : safeBase
  const result = `${clipped}${ext}`.trim()
  return result || fallback
}

export async function uniqueDestination(directory: string, fileName: string): Promise<string> {
  const safe = sanitizeFileName(fileName)
  let candidate = join(directory, safe)
  if (!pathExists(candidate)) return candidate
  const ext = extname(safe)
  const base = ext ? safe.slice(0, -ext.length) : safe
  for (let index = 2; index < 500; index += 1) {
    candidate = join(directory, `${base} (${index})${ext}`)
    if (!pathExists(candidate)) return candidate
  }
  return join(directory, `${base}-${Date.now()}${ext}`)
}

export function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join('/')
}

export function resolveUnder(root: string, relativePath: string | null): string | null {
  if (!relativePath) return null
  if (isAbsolute(relativePath)) return null
  const normalizedRel = normalize(relativePath).replace(/^([.][.][/\\])+/, '')
  const absolute = resolve(root, normalizedRel)
  const rel = relative(root, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return absolute
}

export function isPathInside(child: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

export function isProtectedPath(target: string, storageRoot: string): boolean {
  if (!target) return true
  const resolved = resolve(target)
  if (isPathInside(resolved, storageRoot)) return true
  const driveRoot = /^[A-Za-z]:[\\/]?$/
  if (driveRoot.test(resolved)) return true
  const lower = resolved.toLowerCase()
  const protectedRoots = [
    process.env.WINDIR || 'C:\\Windows',
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    process.env.ProgramData || 'C:\\ProgramData',
    'C:\\System Volume Information'
  ]
  return protectedRoots.some((root) => lower === root.toLowerCase() || lower.startsWith(`${root.toLowerCase()}${sep}`))
}

export async function copyPath(source: string, destination: string, isDirectory: boolean): Promise<void> {
  await ensureDir(dirname(destination))
  if (isDirectory) {
    await fs.cp(source, destination, {
      recursive: true,
      force: true,
      errorOnExist: false,
      preserveTimestamps: true
    })
    return
  }
  try {
    await fs.copyFile(source, destination, fsConstants.COPYFILE_FICLONE)
  } catch {
    await fs.copyFile(source, destination)
  }
}

export async function movePath(source: string, destination: string, isDirectory: boolean): Promise<void> {
  await ensureDir(dirname(destination))
  try {
    await fs.rename(source, destination)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  await copyPath(source, destination, isDirectory)
  await fs.rm(source, { recursive: true, force: true })
}

export async function removePath(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

export async function freeDiskBytes(target: string): Promise<number> {
  try {
    const stats = await fs.statfs(target)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function normalizeIdentityPath(target: string): string {
  return resolve(target).replace(/\//g, '\\').toLowerCase()
}

export function fileIdentity(
  target: string,
  stat: { size: number; mtimeMs: number },
  type: string
): string {
  return `file:${normalizeIdentityPath(target)}:${stat.size}:${Math.round(stat.mtimeMs)}:${type}`
}

export function fileMtime(target: string): number {
  try {
    return statSync(target).mtimeMs
  } catch {
    return 0
  }
}

export function baseNameOf(target: string): string {
  return basename(target) || '未命名'
}

export function humanErrorTarget(target: string): string {
  return baseNameOf(target)
}
