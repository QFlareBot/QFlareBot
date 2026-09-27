/**
 * 表名占位展开与越界拒绝。这是"卸载能清干净数据"的前提：表名不强制带前缀，
 * 框架就枚举不出一个插件建过哪些表。
 */
import { describe, expect, it } from 'vitest'
import { createScopedDB } from './scoped.js'
import { flattenForExec, prefixesCollide, scopeSql, tablePrefix } from './sqlScope.js'

const P = tablePrefix('hello')
const scope = (sql: string) => scopeSql(sql, P)

describe('tablePrefix', () => {
  it('把插件名里的非法字符换成下划线，结果是合法裸标识符', () => {
    expect(tablePrefix('hello')).toBe('p_hello_')
    expect(tablePrefix('@scope/my-plugin')).toBe('p__scope_my_plugin_')
  })

  it('前缀不是单射：- 与 _ 混用会落到同一个前缀（安装时要拦、清理时要避）', () => {
    expect(tablePrefix('my-plugin')).toBe(tablePrefix('my_plugin'))
    expect(prefixesCollide('my-plugin', 'my_plugin')).toBe(true)
    expect(prefixesCollide('hello', 'hello2')).toBe(false)
    // 同名不算碰撞，否则重装/升级会被自己挡住
    expect(prefixesCollide('hello', 'hello')).toBe(false)
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

  it('视图、索引、触发器名也得带前缀', () => {
    for (const sql of [
      'CREATE VIEW x AS SELECT * FROM {notes}',
      'CREATE TEMP VIEW IF NOT EXISTS x AS SELECT 1',
      'DROP VIEW x',
      'DROP INDEX x',
      'DROP INDEX IF EXISTS x',
      'CREATE UNIQUE INDEX x ON {notes}(a)',
      'CREATE TEMPORARY TRIGGER x AFTER INSERT ON {notes} BEGIN SELECT 1; END',
      'DROP TRIGGER x',
    ]) {
      expect(() => scope(sql), sql).toThrow(/不属于本插件的表名 x/)
    }
  })

  it('触发器挂到别人的表上也拦', () => {
    expect(() => scope('CREATE TRIGGER {tr} AFTER INSERT ON rt_installs BEGIN SELECT 1; END')).toThrow(
      /不属于本插件的表名 rt_installs/,
    )
    // AFTER UPDATE 放行了，挂的表还是由 ON 管；OF 后面叫 view 的列也不影响
    expect(() => scope('CREATE TRIGGER {tr} AFTER UPDATE ON rt_installs BEGIN SELECT 1; END')).toThrow(
      /不属于本插件的表名 rt_installs/,
    )
    expect(() => scope('CREATE TRIGGER {tr} AFTER UPDATE OF view ON rt_installs BEGIN SELECT 1; END')).toThrow(
      /不属于本插件的表名 rt_installs/,
    )
    // 触发器体里的 UPDATE 是真的 UPDATE 语句
    expect(() => scope('CREATE TRIGGER {tr} AFTER INSERT ON {t} BEGIN UPDATE rt_installs SET x = 1; END')).toThrow(
      /不属于本插件的表名 rt_installs/,
    )
  })

  it('列名叫 view / trigger 放行了，但后面真正的表名照样查', () => {
    expect(() => scope('SELECT view FROM rt_installs')).toThrow(/不属于本插件的表名 rt_installs/)
    expect(() => scope('SELECT trigger FROM {a} JOIN rt_installs ON 1')).toThrow(/不属于本插件的表名 rt_installs/)
  })

  it('IS [NOT] DISTINCT FROM 放行了，但语句自己的 FROM 照样查', () => {
    expect(() => scope('SELECT a IS DISTINCT FROM b FROM rt_installs')).toThrow(/不属于本插件的表名 rt_installs/)
    expect(() => scope('SELECT a IS NOT DISTINCT FROM b FROM rt_installs')).toThrow(/不属于本插件的表名 rt_installs/)
    // 不是 IS 引出的 DISTINCT 不算
    expect(() => scope('SELECT DISTINCT a FROM rt_installs')).toThrow(/不属于本插件的表名 rt_installs/)
  })

  it('CTE 列清单里的列名不会被当成 CTE 名放行', () => {
    // 以前记下的"CTE 名"是 AS 前面的词，也就是列清单的最后一列
    expect(() => scope('WITH c(rt_installs) AS (SELECT 1) SELECT * FROM rt_installs')).toThrow(
      /不属于本插件的表名 rt_installs/,
    )
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

  it('带列清单的 CTE：名字取括号前面的词', () => {
    const sql = 'WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x<5) SELECT x FROM cnt'
    expect(scope(sql)).toBe(sql)
    expect(
      scope('WITH a (x) AS (SELECT 1), b(y, z) AS NOT MATERIALIZED (SELECT x, x FROM a) SELECT * FROM b JOIN {notes} ON 1'),
    ).toBe('WITH a (x) AS (SELECT 1), b(y, z) AS NOT MATERIALIZED (SELECT x, x FROM a) SELECT * FROM b JOIN p_hello_notes ON 1')
  })

  it('列名可以叫 view / trigger：只有 CREATE / DROP 之类后面的才是视图、触发器', () => {
    expect(scope('CREATE TABLE IF NOT EXISTS {t} (id INTEGER PRIMARY KEY, view INTEGER)')).toBe(
      'CREATE TABLE IF NOT EXISTS p_hello_t (id INTEGER PRIMARY KEY, view INTEGER)',
    )
    expect(scope('SELECT view FROM {t}')).toBe('SELECT view FROM p_hello_t')
    // 前面隔着逗号的 UNIQUE 不算
    expect(scope('CREATE TABLE {t} (a TEXT UNIQUE, view INTEGER, trigger TEXT)')).toBe(
      'CREATE TABLE p_hello_t (a TEXT UNIQUE, view INTEGER, trigger TEXT)',
    )
    // 以前 trigger 会让后面 JOIN 的 ON 被当成表名
    expect(scope('SELECT trigger, view FROM {a} AS a JOIN {b} AS b ON a.id = b.id')).toBe(
      'SELECT trigger, view FROM p_hello_a AS a JOIN p_hello_b AS b ON a.id = b.id',
    )
    expect(scope('UPDATE {t} SET view = view + 1 WHERE id = ?')).toBe('UPDATE p_hello_t SET view = view + 1 WHERE id = ?')
    expect(scope('CREATE INDEX IF NOT EXISTS {t_view} ON {t}(view)')).toBe(
      'CREATE INDEX IF NOT EXISTS p_hello_t_view ON p_hello_t(view)',
    )
  })

  it('UPDATE 触发器：AFTER UPDATE [OF 列] 后面不是表名，挂的表看 ON', () => {
    expect(scope('CREATE TRIGGER IF NOT EXISTS {tr} AFTER UPDATE ON {t} BEGIN UPDATE {log} SET n = n + 1; END')).toBe(
      'CREATE TRIGGER IF NOT EXISTS p_hello_tr AFTER UPDATE ON p_hello_t BEGIN UPDATE p_hello_log SET n = n + 1; END',
    )
    expect(scope('CREATE TRIGGER {tr} BEFORE UPDATE OF view ON {t} BEGIN SELECT 1; END')).toBe(
      'CREATE TRIGGER p_hello_tr BEFORE UPDATE OF view ON p_hello_t BEGIN SELECT 1; END',
    )
  })

  it('IS [NOT] DISTINCT FROM 里的 FROM 不是表位置', () => {
    expect(scope('SELECT a IS DISTINCT FROM b FROM {t}')).toBe('SELECT a IS DISTINCT FROM b FROM p_hello_t')
    expect(scope('SELECT * FROM {t} WHERE a IS NOT DISTINCT FROM ?')).toBe(
      'SELECT * FROM p_hello_t WHERE a IS NOT DISTINCT FROM ?',
    )
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

/** 把连续空白归一，只比较语句本身 */
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim()

describe('flattenForExec：交给 D1 exec 之前压成一行', () => {
  it('多行 DDL 压成一行，多条语句与分号原样保留', () => {
    const flat = flattenForExec(`
      CREATE TABLE IF NOT EXISTS t (
        a TEXT NOT NULL,
        PRIMARY KEY (a)
      );\r
      CREATE INDEX IF NOT EXISTS t_a ON t(a);
    `)
    expect(flat).not.toMatch(/[\r\n]/)
    expect(squash(flat)).toBe('CREATE TABLE IF NOT EXISTS t ( a TEXT NOT NULL, PRIMARY KEY (a) ); CREATE INDEX IF NOT EXISTS t_a ON t(a);')
  })

  it('去掉注释：压成一行后 -- 会把后面的语句全吞掉', () => {
    const flat = flattenForExec('CREATE TABLE t (a TEXT) -- 备注\n; /* 块\n注释 */ CREATE TABLE u (b TEXT); -- 结尾注释')
    expect(squash(flat)).toBe('CREATE TABLE t (a TEXT) ; CREATE TABLE u (b TEXT);')
  })

  it('引号里的内容原样保留：-- 和 ; 不当注释 / 分隔，转义引号认得出', () => {
    const sql = `INSERT INTO t (v, w) VALUES ('a -- b; c', 'it''s /* x */') ; SELECT "col--x", [odd;name], \`q\`\`q\` FROM t`
    expect(flattenForExec(sql)).toBe(sql)
  })

  it('引号里有换行：直接报可读的错，不留给 D1 报 incomplete input', () => {
    expect(() => flattenForExec("INSERT INTO t (v) VALUES ('第一行\n第二行')")).toThrow(/引号内不能换行/)
    expect(() => flattenForExec('CREATE TABLE "a\nb" (x)')).toThrow(/引号内不能换行/)
  })

  it('没配对的引号原样交给 D1 去报语法错误', () => {
    expect(flattenForExec("SELECT 'oops\nFROM t")).toBe("SELECT 'oops\nFROM t")
  })
})

describe('ctx.db.exec', () => {
  function recordingD1() {
    const seen: string[] = []
    const d1 = {
      async exec(sql: string) {
        seen.push(sql)
        return { count: 0, duration: 0 }
      },
    } as unknown as D1Database
    return { d1, seen }
  }

  it('交给 D1 的是展开了表前缀、压成一行的 SQL（wifepicker 那种多行建表不再断在第一行）', async () => {
    const { d1, seen } = recordingD1()
    await createScopedDB(d1, 'hello').exec(`
      CREATE TABLE IF NOT EXISTS {notes} (
        id TEXT PRIMARY KEY, -- 主键
        ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS {notes_ts} ON {notes}(ts);
    `)
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toMatch(/[\r\n]/)
    expect(squash(seen[0]!)).toBe(
      'CREATE TABLE IF NOT EXISTS p_hello_notes ( id TEXT PRIMARY KEY, ts INTEGER NOT NULL ); CREATE INDEX IF NOT EXISTS p_hello_notes_ts ON p_hello_notes(ts);',
    )
  })

  it('只有注释或空白：不调用 D1（D1 对空 SQL 会报错）', async () => {
    const { d1, seen } = recordingD1()
    const db = createScopedDB(d1, 'hello')
    await db.exec('-- 以后再建表\n')
    await db.exec('   ')
    expect(seen).toEqual([])
  })
})
