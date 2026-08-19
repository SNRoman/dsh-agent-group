import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

export default {
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  fixedExtension: false,
  clean: false,
  plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
}
