import { DEFAULTS, ALLOWED_MIME_TYPES, GIT_PROVIDERS } from '@/lib/pi-shared'

const maxFileSizeMB = Number(import.meta.env.VITE_MAX_FILE_SIZE_MB ?? DEFAULTS.FILE_LIMITS.MAX_SIZE_MB)
const maxUploadSizeMB = Number(import.meta.env.VITE_MAX_UPLOAD_SIZE_MB ?? DEFAULTS.FILE_LIMITS.MAX_UPLOAD_SIZE_MB)
const config = {
  API_BASE_URL: import.meta.env.VITE_API_URL ?? '',
  SERVER_PORT: Number(import.meta.env.VITE_SERVER_PORT ?? DEFAULTS.SERVER.PORT),
  FILE_LIMITS: {
    MAX_SIZE_BYTES: maxFileSizeMB * 1024 * 1024,
    MAX_UPLOAD_SIZE_BYTES: maxUploadSizeMB * 1024 * 1024,
  },
}

export const API_BASE_URL = config.API_BASE_URL
export const SUBPOLAR_API_BASE_URL = `${config.API_BASE_URL}/api`
export const SERVER_PORT = config.SERVER_PORT
export const FILE_LIMITS = config.FILE_LIMITS

export { DEFAULTS, ALLOWED_MIME_TYPES, GIT_PROVIDERS }
export default config
