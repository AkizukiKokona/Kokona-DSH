import type { KokonaApi } from '../../shared/api'

declare global {
  interface Window {
    kokona: KokonaApi
  }
}

export {}
