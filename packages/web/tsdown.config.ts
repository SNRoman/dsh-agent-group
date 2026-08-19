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
    clean: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@dsh-agent-workspace/web", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
