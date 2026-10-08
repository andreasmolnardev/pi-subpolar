export { parseJsonc } from './pi-shared'

export function hasJsoncComments(content: string): boolean {
  return content.split('\n').some(line => {
    const trimmed = line.trim()
    return trimmed.startsWith('//') || trimmed.startsWith('/*')
  })
}
