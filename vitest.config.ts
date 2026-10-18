import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const browserSourceTests = [
  'tests/workspace-pending-work-dom.spec.ts',
  'tests/workspace-recall-dom.spec.ts',
  'tests/workspace-chat-dom.spec.ts',
  'tests/workspace-refresh-shell-dom.spec.ts',
  'tests/workspace-organizations-store.spec.ts',
  'tests/workspace-organizations-dom.spec.ts',
  'tests/workspace-activity-dom.spec.ts',
  'tests/workspace-activity-store.spec.ts',
  'tests/workspace-definition-view.spec.ts',
  'tests/workspace-memory-view.spec.ts',
  'tests/workspace-task-dom.spec.ts',
  'tests/workspace-task-view.spec.ts',
  'tests/workspace-view.spec.ts',
]

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.spec.ts'],
          exclude: ['tests/workspace-locale.spec.ts', ...browserSourceTests],
        },
      },
      {
        resolve: {
          alias: {
            '@deepseek-ai/dsh-client-store': fileURLToPath(new URL('./tests/fixtures/client-store.ts', import.meta.url)),
            '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/fixtures/client-ui-primitives.ts', import.meta.url)),
          },
        },
        test: {
          name: 'browser-source',
          include: browserSourceTests,
        },
      },
      {
        resolve: {
          alias: {
            '@deepseek-ai/dsh-client-store': fileURLToPath(new URL('./tests/fixtures/client-store.ts', import.meta.url)),
            '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/fixtures/client-ui-primitives.ts', import.meta.url)),
          },
        },
        test: {
          name: 'locale',
          include: ['tests/workspace-locale.spec.ts'],
        },
      },
    ],
  },
})
