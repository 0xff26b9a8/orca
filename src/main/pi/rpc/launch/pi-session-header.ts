import { open, realpath } from 'node:fs/promises'
import { normalize } from 'node:path'
import { z } from 'zod'

const headerSchema = z.object({
  type: z.literal('session'),
  cwd: z.string().min(1),
  id: z.string().optional()
})
const titleSlotSchema = z.object({ type: z.literal('title'), v: z.literal(1), title: z.string() })

export async function readPiSessionHeader(
  file: string,
  options?: { titleSlot?: boolean }
): Promise<{ cwd: string; id?: string } | null> {
  let descriptor
  try {
    descriptor = await open(file, 'r')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0)
    const data = buffer.subarray(0, bytesRead).toString('utf8')
    let lf = data.indexOf('\n')
    if (lf === -1) {
      throw new Error('Pi session header is incomplete or oversized')
    }
    let record: unknown = JSON.parse(data.slice(0, lf))
    if (options?.titleSlot && titleSlotSchema.safeParse(record).success) {
      const start = lf + 1
      lf = data.indexOf('\n', start)
      if (lf === -1) {
        throw new Error('OMP session header is incomplete or oversized')
      }
      record = JSON.parse(data.slice(start, lf))
    }
    return headerSchema.parse(record)
  } finally {
    await descriptor.close()
  }
}

export async function samePiDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> =>
    realpath(value).catch(() => normalize(value))
  const [a, b] = await Promise.all([canonical(left), canonical(right)])
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
