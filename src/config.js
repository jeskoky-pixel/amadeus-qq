import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  presetGuard: z.boolean().default(false),
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
  permissions: z.object({
    defaultMode: z.string().default('safe-chat'),
    groupDefaultMode: z.string().default('safe-chat'),
    privateDefaultMode: z.string().default('safe-chat'),
    ownerPrivateIds: z.array(z.string()).default([]),
    ownerTools: z.array(z.string()).default([]),
    globalDeny: z.array(z.string()).default([]),
    accountGrants: z.object({
      byBotId: z.dict(z.object({ qzonePublish: z.boolean().default(false) })).default({}),
    }).default({}),
  }).default({}),
})
