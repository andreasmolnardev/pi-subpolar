import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

async function tests(directory: string): Promise<string[]> {
  const paths: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await tests(path))
    else if (entry.name.endsWith('.test.ts')) paths.push(path)
  }
  return paths.sort()
}

const native: string[] = []
const vitest: string[] = []
for (const path of await tests('server')) {
  const source = await Bun.file(path).text()
  if (/from\s+['"]bun:/.test(source)) native.push(path)
  else vitest.push(path)
}

let failed = false
for (const command of [
  native.length ? ['bun', 'test', ...native] : [],
  vitest.length ? ['bun', 'x', '--no-install', 'vitest', 'run', '--maxWorkers=2', ...vitest] : [],
]) {
  if (!command.length) continue
  const process = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
  if (await process.exited !== 0) failed = true
}
process.exitCode = failed ? 1 : 0
