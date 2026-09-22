import { describe, expect, it } from 'vitest'
import { inspectSafeDelegationDenial } from '../scripts/release-smoke-contract.mjs'

const workspace = {
  workspaceId: 'local', agents: { colleague: { id: 'opaque-colleague-uuid' } },
  tasks: { root: { id: 'opaque-root-uuid' } }, delegationGrants: { grant: { id: 'opaque-grant-uuid' } },
}

function denial(text = 'Error: Workspace task request is not permitted.') {
  return { type: 'tool/result', data: { message: {
    source: { kind: 'tool', callId: 'v020-safe-failure' },
    content: [{ type: 'tool-result', toolCallId: 'v020-safe-failure', isError: true, content: [{ type: 'text', text }] }],
  } } }
}

describe('Browser authoritative delegation denial', () => {
  it('waits for the exact tool result and accepts one safe refusal', () => {
    expect(inspectSafeDelegationDenial([], workspace)).toBeUndefined()
    expect(inspectSafeDelegationDenial([denial()], workspace)).toEqual(denial())
  })

  it.each(['opaque-colleague-uuid', 'opaque-root-uuid', 'opaque-grant-uuid'])('rejects the actual workspace identifier %s', id => {
    expect(() => inspectSafeDelegationDenial([denial(`Error: Workspace task request is not permitted. ${id}`)], workspace)).toThrow('workspace identifier')
  })

  it('rejects a successful invocation, duplicate refusal, and Host metadata', () => {
    const successful = denial()
    successful.data.message.content[0]!.isError = false
    expect(() => inspectSafeDelegationDenial([successful], workspace)).toThrow('safe policy denial')
    expect(() => inspectSafeDelegationDenial([denial(), denial()], workspace)).toThrow('exactly one')
    expect(() => inspectSafeDelegationDenial([{ ...denial(), data: { ...denial().data, meta: { host: {} } } }], workspace)).toThrow('Host metadata')
  })
})
