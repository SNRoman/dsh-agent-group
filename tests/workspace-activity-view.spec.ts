import { describe, expect, it } from 'vitest'
import type { WorkspaceActivitySnapshot, WorkspaceSnapshot } from '../packages/web/src/client/contracts.ts'
import { projectWorkspaceActivity } from '../packages/web/src/client/activity-view-model.ts'

function workspace(): WorkspaceSnapshot {
  return {
    workspaceId: 'workspace', revision: 8, nextId: 9, nextSequence: 9,
    definitions: {}, definitionRevisions: {}, memberships: {}, events: [], memoryEntries: [], sessionBindings: {},
    agents: {
      alice: { id: 'alice', name: 'Alice', definitionId: 'role', definitionRevisionId: 'revision', employmentStatus: 'employed', employmentPeriods: [] },
      bob: { id: 'bob', name: 'Bob', definitionId: 'role', definitionRevisionId: 'revision', employmentStatus: 'departed', employmentPeriods: [] },
    },
    rooms: { room: { id: 'room', kind: 'group', name: 'Engineering' } },
    tasks: { task: { id: 'task', rootTaskId: 'task', title: 'Ship release', status: 'open' } },
    taskAssignments: {}, delegationGrants: {}, childRuns: {},
  }
}

function runtime(): WorkspaceActivitySnapshot {
  return {
    version: 7, workspaceRevision: 8,
    agents: [
      { agentId: 'alice', status: 'active', usingTool: true },
      { agentId: 'bob', status: 'failed', usingTool: false, error: { code: 'failed', summary: 'Safe Bob failure.' } },
    ],
    activities: [
      {
        activityId: 'task-run', agentId: 'alice', source: { kind: 'task', taskId: 'task', attemptId: 'attempt' },
        messageId: 'task-message', startOrder: 2, status: 'responding', claimed: { sessionId: 'task-session', turn: 4 },
        blocks: [{ kind: 'tool', index: 0, callId: 'call', name: 'shell', arguments: '{}', status: 'running' }],
      },
      {
        activityId: 'room-run', agentId: 'alice', source: { kind: 'room', roomId: 'room' },
        messageId: 'room-message', startOrder: 1, status: 'stopping', claimed: { sessionId: 'room-session', turn: 3 },
        blocks: [{ kind: 'text', index: 0, text: 'Working' }], terminalReason: 'cancelled',
      },
      {
        activityId: 'foreign', agentId: 'missing', source: { kind: 'room', roomId: 'missing-room' },
        messageId: 'foreign-message', startOrder: 3, status: 'responding', claimed: { sessionId: 'foreign-session', turn: 5 },
        blocks: [], error: { code: 'safe', summary: 'Display-safe failure.' },
      },
    ],
  }
}

describe('workspace activity projection', () => {
  it('projects the Host layers once for agents, rooms, tasks, and exact controls', () => {
    const projected = projectWorkspaceActivity(workspace(), runtime())

    expect(projected.activities.map(item => [item.activityId, item.status, item.agent.label, item.source.label, item.usingTool])).toEqual([
      ['room-run', 'stopping', 'Alice', 'Engineering', false],
      ['task-run', 'responding', 'Alice', 'Ship release', true],
      ['foreign', 'responding', 'missing', 'missing-room', false],
    ])
    expect(projected.agents.alice).toMatchObject({ status: 'active', usingTool: true })
    expect(projected.agents.bob).toMatchObject({ status: 'failed', error: { summary: 'Safe Bob failure.' } })
    expect(projected.summary).toEqual({ status: 'failed', usingTool: true })
    expect(projected.rooms.room?.map(item => item.activityId)).toEqual(['room-run'])
    expect(projected.tasks.task?.map(item => item.activityId)).toEqual(['task-run'])
    expect(projected.activities[1]?.stopIdentity).toEqual({
      activityId: 'task-run', agentId: 'alice', messageId: 'task-message', sessionId: 'task-session', turn: 4,
    })
    expect(projected.activities[0]?.stopIdentity).toBeUndefined()
    expect(projected.activities[2]?.stopIdentity).toBeUndefined()
    expect(projected.activities.map(item => item.owned)).toEqual([true, true, false])
  })

  it('deduplicates durable ids deterministically without mutating either input', () => {
    const state = workspace()
    const first = runtime()
    const duplicate = { ...first.activities[1]!, status: 'queued' as const, claimed: undefined }
    const left = { ...first, activities: [duplicate, ...first.activities] }
    const right = { ...first, activities: [...first.activities, duplicate] }
    const beforeState = structuredClone(state)
    const beforeLeft = structuredClone(left)

    expect(projectWorkspaceActivity(state, left)).toEqual(projectWorkspaceActivity(state, right))
    expect(projectWorkspaceActivity(state, left).activities.filter(item => item.activityId === 'room-run')).toHaveLength(1)
    expect(state).toEqual(beforeState)
    expect(left).toEqual(beforeLeft)
  })

  it('keeps idle canonical agents and does not invent stop ownership for queued, settled, or unclaimed work', () => {
    const state = workspace()
    const base = runtime()
    const activity = {
      ...base,
      agents: [],
      activities: base.activities.slice(0, 1).flatMap(item => [
        { ...item, activityId: 'queued', status: 'queued' as const, claimed: undefined },
        { ...item, activityId: 'settled', status: 'settled' as const },
        { ...item, activityId: 'unclaimed', status: 'responding' as const, claimed: undefined },
      ]),
    }

    const projected = projectWorkspaceActivity(state, activity)
    expect(projected.agents.alice).toMatchObject({ status: 'idle', usingTool: false })
    expect(projected.agents.bob).toMatchObject({ status: 'idle', usingTool: false })
    expect(projected.activities.every(item => item.stopIdentity === undefined)).toBe(true)
  })
})
