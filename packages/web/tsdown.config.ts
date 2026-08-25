const SHARED_BROWSER_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-primitives',
])

export default [
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    fixedExtension: false,
    clean: false,
  },
  {
    entry: {
      client: 'lib/types/client/index.js',
    },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    clean: false,
    deps: {
      neverBundle: (specifier) => SHARED_BROWSER_MODULES.has(specifier),
      alwaysBundle: (specifier) => !SHARED_BROWSER_MODULES.has(specifier),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@dsh-agent-group/web", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
