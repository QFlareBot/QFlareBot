/**
 * 表名占位展开与越界拒绝。这是"卸载能清干净数据"的前提：表名不强制带前缀，
 * 框架就枚举不出一个插件建过哪些表。
 */
import { describe, expect, it } from 'vitest'
import { scopeSql, tablePrefix } from './sqlScope.js'

const P = tablePrefix('hello')
const scope = (sql: string) => scopeSql(sql, P)

describe('tablePrefix', () => {
  it('把插件名里的非法字符换成下划线，结果是合法裸标识符', () => {
    expect(tablePrefix('hello')).toBe('p_hello_')
    expect(tablePrefix('@scope/my-plugin')).toBe('p__scope_my_plugin_')
  })
})

describe('占位符展开', () => {
  it('展开常见语句里的表名', () => {
    expect(scope('SELECT * FROM {notes} WHERE id = ?')).toBe('SELECT * FROM p_hello_notes WHERE id = ?')
    expect(scope('INSERT INTO {notes} (id) VALUES (?)')).toBe('INSERT INTO p_hello_notes (id) VALUES (?)')
    expect(scope('UPDATE {notes} SET x = ?')).toBe('UPDATE p_hello_notes SET x = ?')
    expect(scope('DELETE FROM {notes}')).toBe('DELETE FROM p_hello_notes')
    expect(scope('DROP TABLE {notes}')).toBe('DROP TABLE p_hello_notes')
  })

  it('CREATE TABLE IF NOT EXISTS：表名前夹着噪声词也认得出', () => {
    expect(scope('CREATE TABLE IF NOT EXISTS {notes} (id TEXT PRIMARY KEY)')).toBe(
      'CREATE TABLE IF NOT EXISTS p_hello_notes (id TEXT PRIMARY KEY)',
    )
  })

  it('索引名和它挂的表都进命名空间', () => {
    expect(scope('CREATE UNIQUE INDEX IF NOT EXISTS {notes_by_user} ON {notes}(user_id)')).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS p_hello_notes_by_user ON p_hello_notes(user_id)',
    )
  })

  it('JOIN 的 ON 是连接条件，不当表名查', () => {
    expect(scope('SELECT * FROM {a} JOIN {b} ON a.id = b.id')).toBe(
      'SELECT * FROM p_hello_a JOIN p_hello_b ON a.id = b.id',
    )
  })

  it('多条语句各自独立判定', () => {
    expect(scope('CREATE TABLE {a} (x); CREATE TABLE {b} (y);')).toBe(
      'CREATE TABLE p_hello_a (x); CREATE TABLE p_hello_b (y);',
    )
  })

  it('SQLite UPSERT：ON CONFLICT ... DO UPDATE SET 里的 SET 不当表名查', () => {
    expect(
      scope(
        'INSERT INTO {notes} (id, val) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET val = excluded.val, ts = excluded.ts;',
      ),
    ).toBe(
      'INSERT INTO p_hello_notes (id, val) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET val = excluded.val, ts = excluded.ts;',
    )
  })
})

describe('越界的表名一律拒绝', () => {
  it('裸表名指向别的插件或框架自己的表', () => {
    expect(() => scope('SELECT * FROM rt_manifest_plugins')).toThrow(/不属于本插件的表名/)
    expect(() => scope('DROP TABLE p_other_data')).toThrow(/不属于本插件的表名/)
    expect(() => scope('DELETE FROM rt_installs WHERE 1=1')).toThrow(/不属于本插件的表名/)
  })

  it('sqlite_master 也是裸表名，同样拦掉', () => {
    expect(() => scope('SELECT name FROM sqlite_master')).toThrow(/不属于本插件的表名/)
  })

  it('加库名限定绕不过去', () => {
    expect(() => scope('SELECT * FROM main.rt_installs')).toThrow(/不属于本插件的表名/)
  })

  it('用引号包住表名绕不过去', () => {
    expect(() => scope('SELECT * FROM "rt_installs"')).toThrow(/不允许用引号包住表名/)
    expect(() => scope('SELECT * FROM `rt_installs`')).toThrow(/不允许用引号包住表名/)
    expect(() => scope('SELECT * FROM [rt_installs]')).toThrow(/不允许用引号包住表名/)
  })

  it('ATTACH / PRAGMA 能绕开表前缀或窥探整库结构，整条拒绝', () => {
    expect(() => scope("ATTACH DATABASE 'x.db' AS other")).toThrow(/不允许使用 ATTACH/)
    expect(() => scope('PRAGMA table_list')).toThrow(/不允许使用 PRAGMA/)
  })

  it('改名逃出命名空间也拦', () => {
    expect(() => scope('ALTER TABLE {notes} RENAME TO escaped')).toThrow(/不属于本插件的表名/)
  })

  it('但 RENAME COLUMN 的 TO 后面是列名，不该误伤', () => {
    expect(scope('ALTER TABLE {notes} RENAME COLUMN a TO b')).toBe('ALTER TABLE p_hello_notes RENAME COLUMN a TO b')
  })

  it('多语句里夹带一条越界的，整体拒绝', () => {
    expect(() => scope('CREATE TABLE {ok} (x); DROP TABLE rt_installs;')).toThrow(/不属于本插件的表名/)
  })
})

describe('不该误伤的地方', () => {
  it('字符串字面量里的 {} 不是占位符——插件常往库里塞 JSON', () => {
    expect(scope(`INSERT INTO {notes} (j) VALUES ('{"a":1}')`)).toBe(
      `INSERT INTO p_hello_notes (j) VALUES ('{"a":1}')`,
    )
  })

  it('字符串里的表名不算表名', () => {
    expect(scope(`INSERT INTO {notes} (t) VALUES ('FROM rt_installs')`)).toBe(
      `INSERT INTO p_hello_notes (t) VALUES ('FROM rt_installs')`,
    )
  })

  it('转义的单引号不会让扫描器错位', () => {
    expect(scope(`INSERT INTO {notes} (t) VALUES ('it''s fine')`)).toBe(
      `INSERT INTO p_hello_notes (t) VALUES ('it''s fine')`,
    )
  })

  it('注释里的内容一概不看', () => {
    expect(scope('-- DROP TABLE rt_installs\nSELECT * FROM {notes}')).toBe(
      '-- DROP TABLE rt_installs\nSELECT * FROM p_hello_notes',
    )
    expect(scope('/* FROM rt_installs */ SELECT * FROM {notes}')).toBe('/* FROM rt_installs */ SELECT * FROM p_hello_notes')
  })

  it('CTE 名放行——它在语句内遮蔽同名真实表，读不到真表', () => {
    expect(scope('WITH recent AS (SELECT * FROM {notes}) SELECT * FROM recent')).toBe(
      'WITH recent AS (SELECT * FROM p_hello_notes) SELECT * FROM recent',
    )
  })

  it('递归 CTE 在自己体内引用自己', () => {
    const sql = 'WITH RECURSIVE t AS (SELECT 1 UNION SELECT n FROM t) SELECT * FROM t'
    expect(scope(sql)).toBe(sql)
  })

  it('CTE 的放行不跨语句泄漏', () => {
    expect(() => scope('WITH rt_installs AS (SELECT 1) SELECT 1; SELECT * FROM rt_installs;')).toThrow(
      /不属于本插件的表名/,
    )
  })

  it('子查询和别名不是表名', () => {
    expect(scope('SELECT * FROM (SELECT id FROM {notes}) AS t WHERE t.id = ?')).toBe(
      'SELECT * FROM (SELECT id FROM p_hello_notes) AS t WHERE t.id = ?',
    )
    expect(scope('SELECT n.id FROM {notes} AS n')).toBe('SELECT n.id FROM p_hello_notes AS n')
  })

  it('ctx.db.table() 拼出来的旧写法仍然能用：已经带前缀了', () => {
    expect(scope(`SELECT * FROM ${P}notes`)).toBe('SELECT * FROM p_hello_notes')
  })
})

describe('占位符本身的错误给出可读提示', () => {
  it('没配对的花括号', () => {
    expect(() => scope('SELECT * FROM {notes')).toThrow(/没有配对/)
  })

  it('占位名里有非法字符', () => {
    expect(() => scope('SELECT * FROM {no-tes}')).toThrow(/不合法/)
  })
})
