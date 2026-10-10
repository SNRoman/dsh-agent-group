import { describe, expect, test } from 'vitest'
import { WorkspaceAdmission } from '../packages/host/src/workspace-admission.ts'

describe('workspace admission', () => {
  test('reserves before asynchronous work and releases once after settlement', async () => {
    const gate = new WorkspaceAdmission()
    const pending = Promise.withResolvers<void>()
    const flight = gate.run(async () => await pending.promise)
    expect(gate.pending).toBe(1)
    await expect(gate.withIdle(async () => 1)).rejects.toThrow('busy')
    pending.resolve()
    await flight
    expect(gate.pending).toBe(0)
    expect(await gate.withIdle(async () => 1)).toBe(1)
  })

  test('rejects new operations while closed but awaits already admitted operations', async () => {
    const gate = new WorkspaceAdmission()
    const release = gate.reserve()
    gate.close()
    expect(() => gate.reserve()).toThrow('closed')
    expect(() => gate.reopen()).toThrow('busy')
    let drained = false
    const draining = gate.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    release()
    await draining
    expect(gate.pending).toBe(0)
    gate.reopen()
    gate.reserve()()
  })

  test('blocks admissions during export and releases the barrier even on encoder failure', async () => {
    const gate = new WorkspaceAdmission()
    const capture = Promise.withResolvers<void>()
    const exporting = gate.withIdle(async () => { await capture.promise; throw new Error('encoder failed') })
    expect(() => gate.reserve()).toThrow('busy')
    expect(() => gate.close()).toThrow('busy')
    await expect(gate.withIdle(async () => 2)).rejects.toThrow('busy')
    capture.resolve()
    await expect(exporting).rejects.toThrow('encoder failed')
    gate.reserve()()
  })

  test('releases failed operations and wakes all drain observers', async () => {
    const gate = new WorkspaceAdmission()
    const pending = Promise.withResolvers<void>()
    const running = gate.run(async () => { await pending.promise; throw new Error('write failed') })
    gate.close()
    const drained = Promise.all([gate.drain(), gate.drain()])
    pending.resolve()
    await expect(running).rejects.toThrow('write failed')
    await drained
    gate.close()
    gate.reopen()
    expect(await gate.run(async () => 'retry')).toBe('retry')
  })

  test('allows an idle archived snapshot without reopening admissions', async () => {
    const gate = new WorkspaceAdmission()
    gate.close()
    expect(await gate.withIdle(async () => 'archived')).toBe('archived')
    expect(() => gate.reserve()).toThrow('closed')
  })

  test('rolls back a failed archive without cancelling pending work or reopening a later generation', () => {
    const gate = new WorkspaceAdmission()
    const release = gate.reserve()
    const rollback = gate.close()
    rollback()
    expect(gate.pending).toBe(1)
    gate.reserve()()
    gate.close()
    rollback()
    expect(() => gate.reserve()).toThrow('closed')
    release()
  })

  test('retains archive rollback during capture until the exclusive encoder finishes', async () => {
    const gate = new WorkspaceAdmission()
    const rollback = gate.close()
    const encoding = Promise.withResolvers<void>()
    const capture = gate.withIdle(async () => await encoding.promise)
    rollback()
    expect(() => gate.reserve()).toThrow('busy')
    encoding.resolve()
    await capture
    gate.reserve()()
  })
})
