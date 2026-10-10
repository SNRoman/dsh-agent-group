/** Artifact-plane checks for the standalone organization import entry. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, test } from 'vitest'

const hostDirectory = fileURLToPath(new URL('../packages/host', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/v0.2.0/agent-workspace.json', import.meta.url))

describe('built organization import entry', () => {
  test('declares a public ESM and type leaf without loading the Host service', async () => {
    const manifest = JSON.parse(await readFile(`${hostDirectory}/package.json`, 'utf8')) as {
      exports: Record<string, unknown>
    }
    expect(manifest.exports['./workspace-import']).toEqual({
      types: './lib/types/workspace-import.d.ts',
      default: './lib/types/workspace-import.js',
    })
    const declaration = await readFile(`${hostDirectory}/lib/types/workspace-import.d.ts`, 'utf8')
    expect(declaration).toContain('prepareWorkspaceImportV1')
  })

  test('resolves the package export and prepares an old production export in plain Node', async () => {
    const script = `
      import { readFileSync } from 'node:fs';
      import { createForwardWorkspaceExportV1 } from '@dsh-agent-group/host/forward-export';
      import { prepareWorkspaceImportV1 } from '@dsh-agent-group/host/workspace-import';
      const original = JSON.parse(readFileSync(process.argv[1], 'utf8')).tables.workspaces.local;
      const exported = createForwardWorkspaceExportV1(original, { exportedAt: '2026-10-10T00:00:00.000Z' });
      const prepared = prepareWorkspaceImportV1(exported.json, {
        workspaceId: 'organization-built-test',
        limits: { maxBytes: 1000000, maxEntities: 10000, maxEvents: 10000, maxStringBytes: 100000, maxDepth: 32 },
      });
      const deliveryEvents = prepared.state.events.filter(event => 'messageId' in event);
      console.log(JSON.stringify({
        workspaceId: prepared.state.workspaceId,
        sourceWorkspaceId: prepared.sourceWorkspaceId,
        bindings: prepared.state.sessionBindings,
        eventsPreserved: prepared.state.events.length === original.events.length,
        memoriesPreserved: JSON.stringify(prepared.state.memoryEntries) === JSON.stringify(original.memoryEntries),
        messageIdsRebased: deliveryEvents.length > 0 && deliveryEvents
          .every(event => event.messageId === 'agent-workspace-task:organization-built-test:' + event.taskDeliveryAttemptId),
        exportUnchanged: exported.json === createForwardWorkspaceExportV1(original, { exportedAt: '2026-10-10T00:00:00.000Z' }).json,
      }));
    `
    const result = await execa(process.execPath, ['--input-type=module', '-e', script, fixture], {
      cwd: hostDirectory,
      timeout: 20_000,
    })
    expect(JSON.parse(result.stdout)).toEqual({
      workspaceId: 'organization-built-test', sourceWorkspaceId: 'local', bindings: {},
      eventsPreserved: true, memoriesPreserved: true, messageIdsRebased: true, exportUnchanged: true,
    })
    expect(result.stderr).toBe('')
  }, 30_000)
})
