import { describe, expect, it } from 'vitest'
import * as evidence from '../scripts/release-smoke-contract.mjs'

function revisionFixture() {
  return {
    definitions: { role: { id: 'role', name: 'Release engineer', currentRevisionId: 'rev1', revisionIds: ['rev1'] } },
    definitionRevisions: { rev1: { id: 'rev1', definitionId: 'role', number: 1 } },
    agents: Object.fromEntries(['Alice', 'Bob', 'Charlie'].map(name => [name, { id: name, name, definitionId: 'role', definitionRevisionId: 'rev1', employmentPeriods: [{ id: `${name}-period` }], employmentStatus: 'employed' }])),
    rooms: { room: { id: 'room' } }, memberships: { member: { id: 'member' } }, sessionBindings: { Alice: 'session-a', Bob: 'session-b', Charlie: 'session-c' },
    memoryEntries: [{ id: 'm', agentId: 'Alice', eventId: 'event', acquiredBy: 'task' }],
    tasks: { task: { id: 'task', rootTaskId: 'task', status: 'completed' } },
    taskAssignments: { assignment: { id: 'assignment', taskId: 'task', assigneeAgentId: 'Alice' } },
    delegationGrants: { grant: { id: 'grant', rootTaskId: 'task', granteeAgentId: 'Alice', status: 'expired' } },
    childRuns: { child: { id: 'child', taskId: 'task', parentAgentId: 'Alice', status: 'completed' } },
    events: [{ id: 'event', sequence: 1, type: 'definition/created', subjectId: 'role', definitionRevisionId: 'rev1' }],
  }
}

function revised(before: ReturnType<typeof revisionFixture>) {
  const after = structuredClone(before)
  after.definitions.role.currentRevisionId = 'rev2'
  after.definitions.role.revisionIds.push('rev2')
  Object.assign(after.definitionRevisions, { rev2: { id: 'rev2', definitionId: 'role', number: 2 } })
  after.agents.Alice!.definitionRevisionId = 'rev2'
  after.events.push(
    { id: 'revision-event', sequence: 2, type: 'definition/revised', subjectId: 'role', definitionRevisionId: 'rev2' },
    { id: 'assignment-event', sequence: 3, type: 'agent/definition-revision-assigned', subjectId: 'Alice', definitionRevisionId: 'rev2' },
  )
  return after
}

describe('Browser subset revision preservation', () => {
  it('accepts only Alice moving from the exact previous revision to the exact new revision', () => {
    const before = revisionFixture()
    expect(evidence.assertSubsetRevisionEvidence(before, revised(before))).toEqual({
      definitionId: 'role', previousRevisionId: 'rev1', currentRevisionId: 'rev2',
      revisionEventId: 'revision-event', revisionEventSequence: 2,
      assignmentEventId: 'assignment-event', assignmentEventSequence: 3,
      pins: { rev1: ['Bob', 'Charlie'], rev2: ['Alice'] },
    })
  })
  it.each(['Bob', 'Charlie'])('rejects accidentally synchronizing %s', name => {
    const before = revisionFixture(); const after = revised(before)
    after.agents[name]!.definitionRevisionId = 'rev2'
    expect(() => evidence.assertSubsetRevisionEvidence(before, after)).toThrow('pin')
  })
  it.each(['rooms', 'memberships', 'sessionBindings', 'memoryEntries', 'events'] as const)('rejects changed existing %s', key => {
    const before = revisionFixture(); const after = revised(before)
    Object.assign(after, { [key]: Array.isArray(after[key]) ? [] : {} })
    expect(() => evidence.assertSubsetRevisionEvidence(before, after)).toThrow('preserved')
  })
  it('rejects missing, duplicate, or misordered revision-assignment events', () => {
    const before = revisionFixture()
    const missingRevision = revised(before)
    missingRevision.events.splice(-2, 1)
    expect(() => evidence.assertSubsetRevisionEvidence(before, missingRevision)).toThrow('revision event')

    const duplicateAssignment = revised(before)
    duplicateAssignment.events.push({ ...duplicateAssignment.events.at(-1)!, id: 'duplicate-assignment', sequence: 4 })
    expect(() => evidence.assertSubsetRevisionEvidence(before, duplicateAssignment)).toThrow('assignment event')

    const misordered = revised(before)
    misordered.events.at(-2)!.sequence = 4
    expect(() => evidence.assertSubsetRevisionEvidence(before, misordered)).toThrow('event order')
  })
})

describe('Browser Host restart preservation', () => {
  it('accepts the exact durable aggregate after a seed-free restart', () => {
    const before = revisionFixture()
    expect(() => evidence.assertRestartPersistence(before, structuredClone(before))).not.toThrow()
  })

  it.each([
    'definitions', 'definitionRevisions', 'agents', 'rooms', 'memberships', 'events',
    'memoryEntries', 'tasks', 'taskAssignments', 'delegationGrants', 'childRuns', 'sessionBindings',
  ] as const)('rejects changed %s across restart', key => {
    const before = revisionFixture()
    const after = structuredClone(before)
    Object.assign(after, { [key]: Array.isArray(after[key]) ? [] : {} })
    expect(() => evidence.assertRestartPersistence(before, after)).toThrow('restart changed')
  })
})

describe('Browser visible memory evidence', () => {
  const state = { events: [{ id: 'e1', sequence: 1, type: 'room/message', subjectId: 'room', text: 'seed' }], memoryEntries: [{ agentId: 'Alice', eventId: 'e1', acquiredBy: 'room-membership' }] }
  it('joins the visible event sequence to its canonical event id', () => {
    expect(evidence.assertMemoryRows(state, 'Alice', ['Event 1: room/message'], ['e1'])).toEqual(['e1'])
  })
  it('rejects duplicate visible rows, missing rows, and duplicate durable acquisitions', () => {
    expect(() => evidence.assertMemoryRows(state, 'Alice', ['Event 1: room/message', 'Event 1: room/message'], ['e1'])).toThrow('duplicate')
    expect(() => evidence.assertMemoryRows(state, 'Alice', [], ['e1'])).toThrow('memory rows')
    expect(() => evidence.assertMemoryRows({ ...state, memoryEntries: [...state.memoryEntries, ...state.memoryEntries] }, 'Alice', ['Event 1: room/message'], ['e1'])).toThrow('duplicate')
  })
})

describe('Browser exact stop evidence', () => {
  const protocol = ['held', 'responding-observed', 'queued-observed', 'stop-clicked', 'abort-received', 'stopping-observed', 'released', 'settled-observed']
  const before = {
    tasks: { held: { id: 'held', status: 'open' }, queued: { id: 'queued', status: 'open' } },
    sessionBindings: { Alice: 'session-a' },
    events: [
      { id: 'held-start', sequence: 1, type: 'task/delivery-started', taskId: 'held', taskDeliveryAttemptId: 'attempt', messageId: 'message' },
      { id: 'held-accept', sequence: 2, type: 'task/delivery-accepted', taskId: 'held', taskDeliveryAttemptId: 'attempt', messageId: 'message' },
      { id: 'queued-start', sequence: 3, type: 'task/delivery-started', taskId: 'queued', taskDeliveryAttemptId: 'queued-attempt', messageId: 'queued-message' },
      { id: 'queued-accept', sequence: 4, type: 'task/delivery-accepted', taskId: 'queued', taskDeliveryAttemptId: 'queued-attempt', messageId: 'queued-message' },
    ],
  }
  const after = {
    ...before,
    tasks: { ...before.tasks, queued: { id: 'queued', status: 'completed' } },
    events: [
      ...before.events,
      { id: 'held-failure', sequence: 5, type: 'task/delivery-failed', taskId: 'held', taskDeliveryAttemptId: 'attempt', messageId: 'message', failureCode: 'interrupted', failureSummary: 'Delivery was interrupted before a terminal result.' },
      { id: 'queued-result', sequence: 6, type: 'task/result', taskId: 'queued', taskDeliveryAttemptId: 'queued-attempt', messageId: 'queued-message' },
      { id: 'queued-completed', sequence: 7, type: 'task/completed', subjectId: 'queued' },
    ],
  }
  const identity = { activityId: 'activity', taskId: 'held', attemptId: 'attempt', messageId: 'message', agentId: 'Alice', sessionId: 'session-a', queuedTaskId: 'queued' }
  const interruptedPartial = { data: { message: { role: 'assistant', content: [{ type: 'text', text: 'V020_STOP_PARTIAL' }] }, interrupted: true } }
  it('requires exact terminal delivery and the preserved unrelated queued task', () => {
    expect(() => evidence.assertExactStopEvidence({ protocol, identity, terminalActivityId: 'activity', before, after, sessionRows: [interruptedPartial] })).not.toThrow()
  })
  it('rejects releasing before the Browser observed Stopping', () => {
    const reordered = [...protocol]; [reordered[5], reordered[6]] = [reordered[6]!, reordered[5]!]
    expect(() => evidence.assertExactStopEvidence({ protocol: reordered, identity, terminalActivityId: 'activity', before, after, sessionRows: [] })).toThrow('stop protocol')
  })
  it('rejects a different terminal activity, no terminal event, and durable partial output', () => {
    const input = { protocol, identity, terminalActivityId: 'activity', before, after, sessionRows: [interruptedPartial] }
    expect(() => evidence.assertExactStopEvidence({ ...input, terminalActivityId: 'other' })).toThrow('activity')
    expect(() => evidence.assertExactStopEvidence({ ...input, after: before })).toThrow('held attempt')
    expect(() => evidence.assertExactStopEvidence({ ...input, sessionRows: [] })).toThrow('interrupted')
    expect(() => evidence.assertExactStopEvidence({ ...input, sessionRows: [{ data: { message: { role: 'assistant', content: [{ type: 'text', text: 'V020_STOP_PARTIAL' }] } } }] })).toThrow('interrupted')
  })
  it('rejects duplicate or non-interrupted held attempts and incomplete queued lifecycles', () => {
    const input = { protocol, identity, terminalActivityId: 'activity', before, after, sessionRows: [interruptedPartial] }
    expect(() => evidence.assertExactStopEvidence({ ...input, after: { ...after, events: [...after.events, { ...after.events[1], id: 'duplicate-held-accept', sequence: 8 }] } })).toThrow('held attempt')
    expect(() => evidence.assertExactStopEvidence({ ...input, after: { ...after, events: after.events.map(event => event.id === 'held-failure' ? { ...event, failureCode: 'delivery-rejected' } : event) } })).toThrow('interrupted failure')
    expect(() => evidence.assertExactStopEvidence({ ...input, after: { ...after, tasks: { ...after.tasks, held: { id: 'held', status: 'completed' } } } })).toThrow('open and retryable')
    expect(() => evidence.assertExactStopEvidence({ ...input, after: { ...after, events: after.events.filter(event => event.id !== 'queued-completed') } })).toThrow('queued attempt')
  })
})

function taskFixture() {
  const events = [
    { type: 'task/assigned', subjectId: 'assign-root', actor: { type: 'human', id: 'human' } },
    { type: 'task/delivery-started', taskId: 'root', taskDeliveryAttemptId: 'attempt-root', messageId: 'msg-root' },
    { type: 'task/delivery-accepted', taskId: 'root', taskDeliveryAttemptId: 'attempt-root', messageId: 'msg-root', definitionRevisionId: 'rev1' },
    { type: 'task/delegation-granted', subjectId: 'grant', actor: { type: 'human', id: 'human' } },
    { type: 'task/delegated', subjectId: 'assign-derived', actor: { type: 'agent', id: 'Alice' } },
    { type: 'task/delivery-started', taskId: 'derived', taskDeliveryAttemptId: 'attempt-derived', messageId: 'msg-derived' },
    { type: 'task/delivery-accepted', taskId: 'derived', taskDeliveryAttemptId: 'attempt-derived', messageId: 'msg-derived', definitionRevisionId: 'rev1' },
    { type: 'child/run-started', subjectId: 'child', actor: { type: 'agent', id: 'Bob' } },
    { type: 'child/run-finished', subjectId: 'child', childRunStatus: 'completed', text: 'V020_CHILD_RESULT' },
    { type: 'task/result', taskId: 'derived', taskDeliveryAttemptId: 'attempt-derived', definitionRevisionId: 'rev1', text: 'V020_CHILD_RESULT' },
    { type: 'task/completed', subjectId: 'derived', actor: { type: 'agent', id: 'Bob' } },
    { type: 'task/result', taskId: 'root', taskDeliveryAttemptId: 'attempt-root', definitionRevisionId: 'rev1', text: 'V020_ROOT_RESULT' },
    { type: 'task/completed', subjectId: 'root', actor: { type: 'agent', id: 'Alice' } },
  ].map((event, index) => ({ ...event, id: `e${index}`, sequence: index + 1 }))
  return {
    agents: { Alice: { id: 'Alice', name: 'Alice' }, Bob: { id: 'Bob', name: 'Bob' } }, sessionBindings: { Alice: 'session-a', Bob: 'session-b' },
    tasks: { root: { id: 'root', rootTaskId: 'root', title: 'V020_ROOT V020_DELEGATE', status: 'completed' }, derived: { id: 'derived', rootTaskId: 'root', title: 'V020_CHILD', status: 'completed' } },
    taskAssignments: { root: { id: 'assign-root', taskId: 'root', rootTaskId: 'root', assigneeAgentId: 'Alice' }, derived: { id: 'assign-derived', taskId: 'derived', rootTaskId: 'root', assigneeAgentId: 'Bob', grantId: 'grant' } },
    delegationGrants: { grant: { id: 'grant', rootTaskId: 'root', granteeAgentId: 'Alice', grantedByHumanId: 'human', status: 'expired' } },
    childRuns: { child: { id: 'child', taskId: 'derived', parentAgentId: 'Bob', status: 'completed', result: 'V020_CHILD_RESULT' } }, events,
  }
}

function taskSessions() {
  const sessions = [
    ...[['session-a', 'root', 'attempt-root', 'msg-root'], ['session-b', 'derived', 'attempt-derived', 'msg-derived']].map(([id, taskId, attempt, message]) => ({ header: { id }, rows: [{ type: 'user/message', data: { id: message, source: { kind: 'agent-workspace-delivery', source: { kind: 'task', taskId }, taskDeliveryAttemptId: attempt } } }] })),
    { header: { id: 'session-child', parentSession: 'session-b', origin: 'subagent' }, rows: [{ type: 'subagent/descriptor', data: { label: 'workspace-child:derived' } }, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'V020_CHILD_RESULT' }] } } }] },
  ]
  const calls = [
    { session: 0, id: 'v020-delegate', name: 'workspace_delegate_task', args: { rootTaskId: 'root', assigneeAgentId: 'Bob', title: 'V020_CHILD' } },
    { session: 0, id: 'v020-root-complete', name: 'workspace_complete_task', args: { taskId: 'root', result: 'V020_ROOT_RESULT' } },
    { session: 1, id: 'v020-child-run', name: 'workspace_run_child', args: { taskId: 'derived', prompt: 'V020_CHILD_EXECUTION' } },
    { session: 1, id: 'v020-child-complete', name: 'workspace_complete_task', args: { taskId: 'derived', result: 'V020_CHILD_RESULT' } },
  ]
  for (const call of calls) {
    const rows: unknown[] = sessions[call.session]!.rows
    rows.push({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.args) }] } } })
    rows.push({ type: 'tool/result', data: { message: { source: { kind: 'tool', callId: call.id }, content: [{ type: 'tool-result', toolCallId: call.id, isError: false, content: [{ type: 'text', text: call.id === 'v020-child-run' ? 'V020_CHILD_RESULT' : 'ok' }] }] } } })
  }
  return sessions
}

describe('Browser task causality evidence', () => {
  it('accepts the exact root, grant, derived attempt, parent and child Session', () => {
    expect(evidence.assertTaskCausality(taskFixture(), taskSessions())).toMatchObject({ rootTaskId: 'root', derivedTaskId: 'derived', childRunId: 'child', childSessionId: 'session-child' })
  })
  it('rejects wrong root, assignee, grantee, attempt, child parent and duplicate completion', () => {
    const mutations = [
      (state: ReturnType<typeof taskFixture>) => { state.tasks.derived.rootTaskId = 'other' },
      (state: ReturnType<typeof taskFixture>) => { state.taskAssignments.derived.assigneeAgentId = 'Alice' },
      (state: ReturnType<typeof taskFixture>) => { state.delegationGrants.grant.granteeAgentId = 'Bob' },
      (state: ReturnType<typeof taskFixture>) => { state.events[9]!.taskDeliveryAttemptId = 'other' },
      (state: ReturnType<typeof taskFixture>) => { state.childRuns.child.parentAgentId = 'Alice' },
      (state: ReturnType<typeof taskFixture>) => { state.events.push({ ...state.events[10]! }) },
    ]
    for (const mutate of mutations) {
      const state = taskFixture(); mutate(state)
      expect(() => evidence.assertTaskCausality(state, taskSessions())).toThrow()
    }
  })
  it('rejects an unrelated child Session and a missing delivery message', () => {
    const sessions = taskSessions(); sessions[2]!.header.parentSession = 'session-a'
    expect(() => evidence.assertTaskCausality(taskFixture(), sessions)).toThrow('child Session')
    expect(() => evidence.assertTaskCausality(taskFixture(), taskSessions().slice(1))).toThrow('Session')
  })
  it('rejects duplicate tool results and a child tool calling another task', () => {
    const sessions = taskSessions()
    const rows: unknown[] = sessions[1]!.rows
    rows.push(structuredClone(rows[2]))
    expect(() => evidence.assertTaskCausality(taskFixture(), sessions)).toThrow('tool result')
    const wrong = taskSessions()
    const message = wrong[1]!.rows[1] as unknown as { data: { message: { content: { arguments: string }[] } } }
    message.data.message.content[0]!.arguments = JSON.stringify({ taskId: 'root', prompt: 'V020_CHILD_EXECUTION' })
    expect(() => evidence.assertTaskCausality(taskFixture(), wrong)).toThrow('tool arguments')
  })
})
