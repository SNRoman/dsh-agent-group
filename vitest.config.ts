import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            '@deepseek-ai/dsh-client-runtime/client': fileURLToPath(new URL('./tests/fixtures/client-runtime.ts', import.meta.url)),
            '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/fixtures/client-ui-primitives.ts', import.meta.url)),
          },
        },
        test: {
          name: 'unit',
          include: ['tests/**/*.spec.ts'],
          exclude: ['tests/workspace-locale.spec.ts'],
        },
      },
      {
        resolve: {
          alias: {
            '@deepseek-ai/dsh-client-runtime/client': fileURLToPath(new URL('./tests/fixtures/client-runtime.ts', import.meta.url)),
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
