import { resolve } from 'node:path'
import { validateCompatibility } from './source-compatibility.mjs'

await validateCompatibility(resolve('.'))
console.log('Compatibility declaration verified.')
