import type { FlowTrayApi } from '@shared/api'

declare global {
  interface Window {
    flowtray: FlowTrayApi
  }
}

export {}
