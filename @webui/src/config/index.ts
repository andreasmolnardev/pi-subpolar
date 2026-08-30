import { createClientConfig, DEFAULTS, ALLOWED_MIME_TYPES, GIT_PROVIDERS } from '../../../shared/src/config/client'

const config = createClientConfig({
  VITE_API_URL: import.meta.env.VITE_API_URL,
  VITE_SERVER_PORT: import.meta.env.VITE_SERVER_PORT,
  VITE_MAX_FILE_SIZE_MB: import.meta.env.VITE_MAX_FILE_SIZE_MB,
  VITE_MAX_UPLOAD_SIZE_MB: import.meta.env.VITE_MAX_UPLOAD_SIZE_MB,
})

export const API_BASE_URL = config.API_BASE_URL
export const SUBPOLAR_API_BASE_URL = `${config.API_BASE_URL}/api`
export const SERVER_PORT = config.SERVER_PORT
export const FILE_LIMITS = config.FILE_LIMITS

export { DEFAULTS, ALLOWED_MIME_TYPES, GIT_PROVIDERS }
export default config
