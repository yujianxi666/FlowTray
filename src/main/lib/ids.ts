import { randomBytes } from 'node:crypto'

export function createId(prefix = ''): string {
  const time = Date.now().toString(36).padStart(9, '0')
  const random = randomBytes(6).toString('hex')
  return `${prefix}${time}${random}`
}
