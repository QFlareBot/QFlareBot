import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseJsonc } from './jsonc.js'
import type { VersionMetadata } from './types.js'
import type { WranglerConfig } from './wrangler.js'

const exec = promisify(execFile)
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'qqbot-cli-'))
  await build({
    entryPoints: [fileURLToPath(new URL('./cli.ts', import.meta.url))],
    outfile: path.join(dir, 'cli.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['cloudflare:workers'],
  })
  await writeFile(path.join(dir, 'runtime.js'), 'export function createRuntime() {}')
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    core: { version: '0.5.0', source: 'file:runtime.js' }, plugins: [],
  }))
})

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function projectConfig(config: WranglerConfig) {
  await writeFile(path.join(dir, 'wrangler.jsonc'), JSON.stringify(config))
  const env = { ...process.env }
  for (const key of ['CF_KV_ID', 'CF_D1_ID', 'CF_R2_NAME', 'CF_WORKER_NAME']) delete env[key]
  const { stdout } = await exec(process.execPath, [path.join(dir, 'cli.mjs'), 'build',
    '--manifest', path.join(dir, 'manifest.json'), '--wrangler', path.join(dir, 'wrangler.jsonc'), '--out', path.join(dir, 'dist'),
  ], { env })
  const projection = JSON.parse(await readFile(path.join(dir, 'dist/projection.json'), 'utf8')) as { hash: string; metadata: VersionMetadata }
  const generated = parseJsonc<WranglerConfig>(await readFile(path.join(dir, 'wrangler.generated.jsonc'), 'utf8'))
  return { stdout, projection, generated }
}

describe('CLI 原生绑定', () => {
  it('同一目录重建：双绑定 → 单绑定 → 无绑定，移除生效且不改变代码哈希', async () => {
    let hash: string | undefined
    for (const kinds of [['images', 'browser'], ['images'], ['browser'], []] as const) {
      const config: WranglerConfig = {
        compatibility_date: '2026-09-01',
        kv_namespaces: [{ binding: 'KV', id: 'test-kv' }],
        d1_databases: [{ binding: 'DB', database_id: 'test-db' }],
      }
      for (const kind of kinds) config[kind] = { binding: kind.toUpperCase(), remote: true }
      const { projection, generated } = await projectConfig(config)
      hash ??= projection.hash
      expect(projection.hash).toBe(hash)
      expect(projection.metadata.bindings).toEqual([
        { type: 'kv_namespace', name: 'KV', namespace_id: 'test-kv' },
        { type: 'd1', name: 'DB', database_id: 'test-db' },
        ...kinds.map((type) => ({ type, name: type.toUpperCase() })),
      ])
      expect(projection.metadata.keep_bindings).toEqual(['secret_text', 'secret_key', 'secrets_store_secret'])
      for (const kind of ['images', 'browser'] as const) {
        if (config[kind]) expect(generated[kind]).toEqual(config[kind])
        else expect(generated).not.toHaveProperty(kind)
      }
    }
  })

  it.each([
    ['2026-03-23', true, true],
    ['2026-03-24', true, false],
    ['2026-09-01', true, false],
    ['2026-03-23', false, false],
    [undefined, true, false],
  ] as const)('日期 %s、Browser=%s，仅在需要时提醒 quickAction', async (date, browser, warn) => {
    const { stdout, projection, generated } = await projectConfig({
      ...(date ? { compatibility_date: date } : {}),
      ...(browser ? { browser: { binding: 'BROWSER' } } : {}),
    })
    expect(stdout.includes('Browser quickAction()')).toBe(warn)
    expect(projection.metadata.compatibility_date).toBe(date ?? new Date().toISOString().slice(0, 10))
    expect(generated.compatibility_date).toBe(projection.metadata.compatibility_date)
  })
})
