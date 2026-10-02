/**
 * 测试替身要和线上一致：线上会拒绝的写法，本地测试里也得拒绝，否则测试全绿、装上机器人才报错。
 */
import { describe, expect, it } from 'vitest'
import type { DBStatement, ScopedDB } from './context.js'
import { definePlugin } from './plugin.js'
import { createMockContext, createMockSession, runCommand } from './testing.js'

/** 记录收到的 SQL 的 ScopedDB 替身 */
function recordingDB() {
  const seen: Array<{ method: string; sql: string; params: unknown[] }> = []
  const db: ScopedDB = {
    table: (n) => `fake_${n}`,
    async exec(sql) {
      seen.push({ method: 'exec', sql, params: [] })
    },
    async run(sql, ...params) {
      seen.push({ method: 'run', sql, params })
      return { changes: 1 }
    },
    async all<T>(sql: string, ...params: unknown[]) {
      seen.push({ method: 'all', sql, params })
      return [{ id: 1 }] as T[]
    },
    async first<T>(sql: string, ...params: unknown[]) {
      seen.push({ method: 'first', sql, params })
      return { id: 1 } as T
    },
  }
  return { db, seen }
}

const plugin = { name: 'hello' }

describe('mock ctx.db 走线上的表名检查', () => {
  it('越界的表名在本地就抛同样的错，替身收不到', async () => {
    const { db, seen } = recordingDB()
    const ctx = createMockContext(plugin, { db })
    await expect(ctx.db.run('DELETE FROM rt_installs')).rejects.toThrow(/不属于本插件的表名 rt_installs/)
    await expect(ctx.db.all('SELECT name FROM sqlite_master')).rejects.toThrow(/不属于本插件的表名/)
    await expect(ctx.db.first('SELECT * FROM "rt_installs"')).rejects.toThrow(/不允许用引号包住表名/)
    await expect(ctx.db.exec('CREATE TABLE {ok} (x); DROP TABLE p_other_data;')).rejects.toThrow(/不属于本插件的表名/)
    await expect(ctx.db.run('PRAGMA table_list')).rejects.toThrow(/不允许使用 PRAGMA/)
    expect(seen).toEqual([])
  })

  it('exec 还查引号内换行（线上压成一行前会报错）', async () => {
    const { db, seen } = recordingDB()
    const ctx = createMockContext(plugin, { db })
    await expect(ctx.db.exec("INSERT INTO {notes} (v) VALUES ('第一行\n第二行')")).rejects.toThrow(/引号内不能换行/)
    expect(seen).toEqual([])
  })

  it('通过检查的原样交给替身：收到的仍是插件写的 SQL，返回值照旧', async () => {
    const { db, seen } = recordingDB()
    const ctx = createMockContext(plugin, { db })
    const ddl = `
      CREATE TABLE IF NOT EXISTS {notes} (
        id INTEGER PRIMARY KEY, -- 主键
        view INTEGER
      );
    `
    await ctx.db.exec(ddl)
    expect(await ctx.db.run('INSERT INTO {notes} (id) VALUES (?)', 1)).toEqual({ changes: 1 })
    expect(await ctx.db.all('SELECT a IS DISTINCT FROM b FROM {notes}')).toEqual([{ id: 1 }])
    expect(await ctx.db.first('SELECT * FROM {notes} WHERE id = ?', 1)).toEqual({ id: 1 })
    expect(seen).toEqual([
      { method: 'exec', sql: ddl, params: [] },
      { method: 'run', sql: 'INSERT INTO {notes} (id) VALUES (?)', params: [1] },
      { method: 'all', sql: 'SELECT a IS DISTINCT FROM b FROM {notes}', params: [] },
      { method: 'first', sql: 'SELECT * FROM {notes} WHERE id = ?', params: [1] },
    ])
  })

  it('table() 返回线上的前缀（插件名里的非法字符换成下划线），拼出来的旧写法照样通过检查', async () => {
    const { db, seen } = recordingDB()
    const ctx = createMockContext({ name: 'my-plugin' }, { db })
    expect(ctx.db.table('notes')).toBe('p_my_plugin_notes')
    await ctx.db.run(`SELECT * FROM ${ctx.db.table('notes')}`)
    expect(seen).toHaveLength(1)
  })

  it('没注入替身：先查表名，合规的再报「未提供 db」', async () => {
    const ctx = createMockContext(plugin)
    expect(ctx.db.table('notes')).toBe('p_hello_notes')
    await expect(ctx.db.run('SELECT * FROM rt_installs')).rejects.toThrow(/不属于本插件的表名/)
    await expect(ctx.db.run('SELECT * FROM {notes}')).rejects.toThrow(/mock 环境未提供 db/)
    await expect(ctx.db.exec('CREATE TABLE {notes} (x)')).rejects.toThrow(/mock 环境未提供 db/)
    await expect(ctx.db.all('SELECT * FROM {notes}')).rejects.toThrow(/mock 环境未提供 db/)
    await expect(ctx.db.first('SELECT * FROM {notes}')).rejects.toThrow(/mock 环境未提供 db/)
    await expect(ctx.db.batch([{ sql: 'SELECT * FROM {notes}' }])).rejects.toThrow(/mock 环境未提供 db/)
  })
})

describe('mock ctx.db.batch', () => {
  it('整批先过表名检查，有一条越界整批都不交给替身', async () => {
    const { db } = recordingDB()
    const batches: DBStatement[][] = []
    const ctx = createMockContext(plugin, {
      db: { ...db, batch: async (s) => (batches.push([...s]), []) },
    })
    await expect(
      ctx.db.batch([{ sql: 'UPDATE {notes} SET v = 1' }, { sql: 'DELETE FROM rt_installs' }]),
    ).rejects.toThrow(/不属于本插件的表名 rt_installs/)
    expect(batches).toEqual([])
  })

  it('合规的原样交给替身的 batch，返回值照旧；空数组直接返回', async () => {
    const { db } = recordingDB()
    const batches: DBStatement[][] = []
    const ctx = createMockContext(plugin, {
      db: {
        ...db,
        batch: async <T>(s: readonly DBStatement[]) => {
          batches.push([...s])
          return s.map(() => ({ changes: 1, results: [] as T[] }))
        },
      },
    })
    const statements = [{ sql: 'UPDATE {notes} SET v = ? WHERE id = ?', params: [1, 2] }, { sql: 'SELECT * FROM {notes}' }]
    expect(await ctx.db.batch(statements)).toEqual([
      { changes: 1, results: [] },
      { changes: 1, results: [] },
    ])
    expect(await ctx.db.batch([])).toEqual([])
    expect(batches).toEqual([statements])
  })

  it('替身没实现 batch（老的 ScopedDB 替身）：报出来，而不是逐条假装执行', async () => {
    const { db, seen } = recordingDB()
    const ctx = createMockContext(plugin, { db })
    await expect(ctx.db.batch([{ sql: 'UPDATE {notes} SET v = 1' }])).rejects.toThrow(/没有实现 batch/)
    expect(seen).toEqual([])
  })
})

describe('mock session.reply 有线上的被动回复上限', () => {
  it('默认 5 条，第 6 条像线上一样返回失败、不记进 replies', async () => {
    const session = createMockSession()
    for (let i = 1; i <= 5; i++) expect((await session.reply(`${i}`)).ok).toBe(true)
    const sixth = await session.reply('6')
    expect(sixth).toMatchObject({ ok: false, error: '被动回复已达上限 5 条' })
    expect(session.replies).toEqual(['1', '2', '3', '4', '5'])
  })

  it('上限可配置', async () => {
    const session = createMockSession({ maxPassiveReplies: 2 })
    await session.reply('a')
    await session.reply('b')
    expect((await session.reply('c')).ok).toBe(false)
    expect(session.replies).toEqual(['a', 'b'])
  })

  it('typing 不算；stream().end() 算一条', async () => {
    const session = createMockSession({ maxPassiveReplies: 2 })
    await session.typing(5)
    await session.reply('a')
    const stream = session.stream()
    await stream.write('b')
    expect((await stream.end('c')).ok).toBe(true)
    expect((await session.reply('d')).ok).toBe(false)
    expect(session.replies).toEqual(['a', 'bc'])
    expect(session.typingSeconds).toEqual([5])
  })

  it('流的缓冲互相独立，结束幂等，关闭后不可写入', async () => {
    const session = createMockSession({ maxPassiveReplies: 2 })
    const a = session.stream()
    const b = session.stream()
    await a.write('a')
    await b.write('b')
    await a.end('1')
    await a.end('不能重复发送')
    expect((await a.write('关闭后')).ok).toBe(false)
    expect((await b.end('2')).ok).toBe(true)
    expect(session.replies).toEqual(['a1', 'b2'])
  })

  it('runCommand：生成器连发超过上限，多出来的发不出去', async () => {
    const p = definePlugin({
      name: 'spam',
      commands: {
        async *spam() {
          for (let i = 1; i <= 7; i++) yield `${i}`
        },
      },
    })
    const session = await runCommand(p, 'spam')
    expect(session.replies).toEqual(['1', '2', '3', '4', '5'])
    const more = await runCommand(p, 'spam', '', { session: { maxPassiveReplies: 10 } })
    expect(more.replies).toHaveLength(7)
  })
})

describe('mock session 的新字段与群接口路径', () => {
  it('quote 给了才有，没给的字段取默认值', () => {
    expect(createMockSession().quote).toBeUndefined()
    expect(createMockSession({ quote: { content: '原文' } }).quote).toEqual({
      messageId: 'mock-quoted-msg',
      content: '原文',
      attachments: [],
      refIndex: undefined,
    })
    expect(createMockSession({ isBotAdmin: true }).isBotAdmin).toBe(true)
    expect(createMockSession().isBotAdmin).toBe(false)
  })

  it('审批入群申请记录的路径带群 id，和线上一致', async () => {
    const ctx = createMockContext(plugin)
    await ctx.api.group.reviewJoinRequest('G1', 'M1', { approve: true }, 'JR1')
    const { calls } = ctx.api as typeof ctx.api & { calls: Array<{ method: string; path: string }> }
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v2/groups/G1/approval_join_request/M1' })
  })
})
