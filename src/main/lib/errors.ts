import type { ItemError } from '@shared/types'

const CODE_BY_ERRNO: Record<string, ItemError['code']> = {
  EACCES: 'permission',
  EPERM: 'permission',
  EROFS: 'permission',
  ENOENT: 'not_found',
  ENOTDIR: 'not_found',
  ENOSPC: 'disk_full',
  EDQUOT: 'disk_full',
  EFBIG: 'too_large',
  ENAMETOOLONG: 'invalid',
  EINVAL: 'invalid',
  ENOTSUP: 'unsupported',
  EOPNOTSUPP: 'unsupported'
}

export function itemError(
  code: ItemError['code'],
  message: string,
  name?: string
): ItemError {
  return { code, message, name }
}

export function errorFromUnknown(error: unknown, name?: string): ItemError {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code
  if (errno && CODE_BY_ERRNO[errno]) {
    return describeCode(CODE_BY_ERRNO[errno], name)
  }
  return itemError(
    'unknown',
    name ? `处理「${name}」时出现未知错误，请稍后重试。` : '处理时出现未知错误，请稍后重试。',
    name
  )
}

export function describeCode(code: ItemError['code'], name?: string): ItemError {
  const label = name ? `「${name}」` : '内容'
  switch (code) {
    case 'permission':
      return itemError(code, `没有权限读取或写入${label}。请检查文件权限，或以管理员身份运行 FlowTray。`, name)
    case 'not_found':
      return itemError(code, `${label}已不存在，可能被移动或删除。`, name)
    case 'disk_full':
      return itemError(code, `磁盘空间不足，无法写入${label}。请清理磁盘或更换存储位置。`, name)
    case 'too_large':
      return itemError(code, `${label}体积过大，无法暂存。`, name)
    case 'quota':
      return itemError(code, `已超出容量上限，无法保存${label}。请在设置中调高上限，或清理暂存台。`, name)
    case 'unsupported':
      return itemError(code, `暂不支持这种内容：${label}。支持文件、文件夹、图片、文本与链接。`, name)
    case 'invalid':
      return itemError(code, `${label}不是有效的内容。`, name)
    case 'sensitive':
      return itemError(code, `${label}来自隐私排除应用，已跳过收录。`, name)
    case 'clipboard_empty':
      return itemError(code, '剪贴板里没有可暂存的文件、文本或图片。', name)
    case 'hotkey_conflict':
      return itemError(code, '快捷键已被其他应用占用，请换一个组合。', name)
    default:
      return itemError('unknown', `处理${label}时出现未知错误，请稍后重试。`, name)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
