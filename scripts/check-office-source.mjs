import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), 'office')
const manifest = JSON.parse(readFileSync(resolve(root, 'MANIFEST.json'), 'utf8'))

for (const [relativePath, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256')
    .update(readFileSync(resolve(root, relativePath)))
    .digest('hex')
  if (actual !== expected) {
    throw new Error(`Office source drift: ${relativePath}`)
  }
}
