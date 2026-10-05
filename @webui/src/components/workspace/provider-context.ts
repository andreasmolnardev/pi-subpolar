export const ADD_PROVIDER_CONTEXT_EVENT = 'subpolar:add-provider-context'

export type ProviderContext = Readonly<{
  title: string
  body: string
  url?: string
}>

export function addProviderContext(context: ProviderContext): void {
  window.dispatchEvent(new CustomEvent<ProviderContext>(ADD_PROVIDER_CONTEXT_EVENT, { detail: context }))
}

export function formatProviderContext(context: ProviderContext): string {
  return [
    `## ${context.title}`,
    context.url ? `Source: ${context.url}` : '',
    context.body,
  ].filter(Boolean).join('\n')
}
