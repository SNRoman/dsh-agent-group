import { expect, test } from 'vitest'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentId } from '../packages/host/src/ids.ts'
import { EmployeeAgentPool } from '../packages/host/src/runtime.ts'

test.each(['create', 'hide', 'resume'] as const)('retains failed unpublished %s cleanup until disposal can finish', async stage => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const employee = AgentId('alice')
  const cleanupError = new Error('unpublished cleanup failed')
  let failCleanup = true
  let live = true
  const pause = async () => { started.resolve(); await release.promise }
  const handle: AgentHandle = {
    agent: { id: SessionId('unpublished'), whenIdle: stage === 'resume' ? pause : async () => {} } as Agent,
    dispose: async () => { if (failCleanup) throw cleanupError; live = false },
  }
  const pool = new EmployeeAgentPool({
    create: async () => { if (stage === 'create') await pause(); return handle },
    resume: async () => handle,
  }, {
    sessionIdFor: () => stage === 'resume' ? handle.agent.id : undefined,
    recordSessionId: async () => {},
    unhideSession: async () => {},
    hideSession: stage === 'hide' ? pause : async () => {},
  })
  const ensuring = pool.ensure(employee)
  const rejectedAdmission = expect(ensuring).rejects.toBe(cleanupError)
  try {
    await started.promise
    const disposing = pool.dispose(employee)
    const rejectedDisposal = expect(disposing).rejects.toBe(cleanupError)
    release.resolve()
    await rejectedAdmission
    await rejectedDisposal
    expect(pool.handleFor(employee)).toBeUndefined()
    expect(live).toBe(true)
    await expect(pool.ensure(employee)).rejects.toThrow('retirement')
    await expect(pool.dispose(employee)).rejects.toBe(cleanupError)
    failCleanup = false
    await pool.dispose(employee)
    expect(live).toBe(false)
  } finally {
    release.resolve()
    failCleanup = false
    await Promise.allSettled([ensuring, pool.disposeAll()])
  }
})
