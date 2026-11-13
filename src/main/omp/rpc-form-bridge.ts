import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { OMP_RPC_FORM_BRIDGE_SOURCE } from './rpc-form-bridge-source'

export async function ensureOmpRpcFormBridge(directory: string): Promise<string> {
  const source = OMP_RPC_FORM_BRIDGE_SOURCE
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const path = join(directory, `form-ui-${hash}.mjs`)
  if ((await readFile(path, 'utf8').catch(() => null)) === source) {
    return path
  }
  await mkdir(directory, { recursive: true })
  const staged = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(staged, source, { mode: 0o600 })
    await rename(staged, path)
  } finally {
    await rm(staged, { force: true })
  }
  return path
}
