/**
 * 构建时的 cron 检查：写错的表达式只警告、不拦构建——以前的构建不查这个，
 * 已装插件同步上游后不能因为多了这道检查就构建失败。
 */
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPlugin } from './build.js'
import { cronWarnings, extractPluginManifest } from './manifest.js'

// 临时插件里的 `@qqbot/sdk` 直接指向 SDK 源码，不依赖 dist 或 node_modules
const alias = { '@qqbot/sdk': fileURLToPath(new URL('../../sdk/src/index.ts', import.meta.url)) }

const pluginWithCron = (...crons: string[]) => `
import { definePlugin } from '@qqbot/sdk'
export default definePlugin({
  name: 'demo',
  cron: {
${crons.map((c, i) => `    job${i}: { cron: ${JSON.stringify(c)}, handler: async () => {} },`).join('\n')}
  },
})
`

let dir: string

async function writePlugin(source: string): Promise<void> {
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'qflarebot-plugin-demo', version: '1.0.0', type: 'module' }))
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src/index.ts'), source)
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'qqbot-plugin-cli-cron-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('cronWarnings', () => {
  it('合法的表达式（含星期 7、英文缩写）不警告', () => {
    expect(
      cronWarnings({
        name: 'demo',
        cron: [
          { name: 'a', cron: '0 1 * * *' },
          { name: 'b', cron: '0 9 * * MON-FRI' },
          { name: 'c', cron: '0 9 * * 1-7' },
        ],
      }),
    ).toEqual([])
  })

  it('不合法的逐条点名：插件、任务、表达式和原因', () => {
    const warnings = cronWarnings({
      name: 'demo',
      cron: [
        { name: 'ok', cron: '0 1 * * *' },
        { name: 'weekly', cron: '0 9 * * 8' },
        { name: 'bad', cron: '*/0 * * * *' },
      ],
    })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toBe('demo：定时任务「weekly」的 cron 表达式「0 9 * * 8」不合法，运行时不会触发：第 5 段（星期）「8」超出范围 0-7')
    expect(warnings[1]).toMatch(/「bad」.*步进要是正整数/)
  })
})

describe('构建时遇到非法 cron', () => {
  it('抽清单照常成功，只在 stderr 打警告', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writePlugin(pluginWithCron('0 1 * * *', '0 9 * * FUN'))
    const manifest = await extractPluginManifest({ cwd: dir, alias })
    expect(manifest.cron.map((c) => c.cron)).toEqual(['0 1 * * *', '0 9 * * FUN'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatch(/^ {2}⚠ demo：定时任务「job1」.*「FUN」不是合法的值/)
  })

  it('buildPlugin 照常产出 plugin.js 与 manifest.json', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writePlugin(pluginWithCron('60 * * * *'))
    const { outFile, manifest } = await buildPlugin({ cwd: dir, alias })
    expect(manifest.cron).toEqual([{ name: 'job0', cron: '60 * * * *' }])
    await expect(access(outFile)).resolves.toBeUndefined()
    await expect(access(path.join(dir, 'dist/manifest.json'))).resolves.toBeUndefined()
    expect(warn.mock.calls.some(([m]) => String(m).includes('超出范围 0-59'))).toBe(true)
  })

  it('全部合法时一声不吭', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writePlugin(pluginWithCron('0 1 * * *', '30 9 1 * SUN'))
    await extractPluginManifest({ cwd: dir, alias })
    expect(warn).not.toHaveBeenCalled()
  })
})
