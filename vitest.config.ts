import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-runtime/client': fileURLToPath(new URL('./tests/fixtures/client-runtime.ts', import.meta.url)),
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/fixtures/client-ui-primitives.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
