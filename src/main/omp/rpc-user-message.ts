import { z } from 'zod'

export const ompRpcUserMessageSchema = z.union([
  z.object({ role: z.literal('user'), timestamp: z.number().finite() }),
  z.object({
    role: z.literal('custom'),
    customType: z.enum(['skill-prompt', 'collab-prompt']),
    attribution: z.literal('user'),
    timestamp: z.number().finite()
  })
])
