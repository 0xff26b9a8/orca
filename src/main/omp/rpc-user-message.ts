import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'

export const ompRpcUserMessageSchema = lazyZodSchema(() =>
  z.union([
    z.object({ role: z.literal('user'), timestamp: z.number().finite() }),
    z.object({
      role: z.literal('custom'),
      customType: z.enum(['skill-prompt', 'collab-prompt']),
      attribution: z.literal('user'),
      timestamp: z.number().finite()
    })
  ])
)
