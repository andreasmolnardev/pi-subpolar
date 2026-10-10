import type { BrowserPort } from './contracts.ts'

/** Lazy loading keeps tests and deployments without the worker independent of Chromium. */
export function configuredWorkerPort(): BrowserPort | undefined {
  const url = process.env.SUBPOLAR_BROWSER_WORKER_URL
  const token = process.env.SUBPOLAR_BROWSER_WORKER_TOKEN
  if (!url || !token) return undefined
  let instance: Promise<BrowserPort> | undefined
  const get = () =>
    (instance ??= (async () => {
      const modulePath = '../../../packages/subpolar-browser/src/index.ts'
      const { WorkerBrowserPort } = await import(modulePath)
      return new WorkerBrowserPort(url, token) as BrowserPort
    })())
  return new Proxy({} as BrowserPort, {
    get:
      (_target, method) =>
      async (...args: unknown[]) => {
        const port = await get()
        const fn = port[method as keyof BrowserPort]
        if (typeof fn !== 'function')
          throw new Error('Browser worker operation unavailable')
        return Reflect.apply(fn, port, args)
      },
  })
}
