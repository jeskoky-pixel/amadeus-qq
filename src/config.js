import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(false),
  connect: z.boolean().default(false),
  statePath: z.string().default(''),
  sessionCwd: z.string().default(''),
  agentPreset: z.string().default(''),
  httpUrl: z.string().default(''),
  wsUrl: z.string().default(''),
  tokenEnv: z.string().default(''),
  policy: z.object({
    epoch: z.natural().default(0),
    botIds: z.array(z.string()).default([]),
    groupIds: z.array(z.string()).default([]),
    privateIds: z.array(z.string()).default([]),
    triggerNames: z.array(z.string()).default([]),
  }).default({}),
})
