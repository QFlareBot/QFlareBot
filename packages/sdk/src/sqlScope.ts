/**
 * 插件 SQL 的表名归一化：把 `{notes}` 换成 `p_<插件名>_notes`，并拒绝任何指向别处的表名。
 *
 * 这**不是安全边界**——插件和运行时编译进同一个 Worker、同一个 JS realm，真要使坏绕得过去。
 * 它保证的是另外两件事：插件之间不会撞表或误删，以及框架能凭前缀枚举出一个插件建过的所有表。
 * 卸载时数据清得干净，全靠后面这一点。
 *
 * 放在 SDK 里，是为了让 `@qqbot/sdk/testing` 的 mock `ctx.db` 和线上走同一套规则：写错的 SQL
 * 在本地测试里就抛一样的错，不用等装上机器人才发现。运行时从这里重新导出（runtime 的 sqlScope.ts）。
 * 插件代码用不着直接 import 它，`ctx.db` 已经替你做了。
 */

/** 这些关键字之后的标识符是表名 */
const TABLE_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE'])
/**
 * 这些关键字之后是同一命名空间下的索引 / 视图 / 触发器名——但只在 DDL 里算：VIEW、TRIGGER 在 SQLite 里
 * 还能当列名用（`SELECT view FROM {t}`），所以只认紧跟在 SCHEMA_LEADS 后面的
 */
const SCHEMA_KEYWORDS = new Set(['INDEX', 'VIEW', 'TRIGGER'])
/** `CREATE [UNIQUE] INDEX`、`CREATE [TEMP|TEMPORARY] VIEW/TRIGGER`、`DROP INDEX/VIEW/TRIGGER` */
const SCHEMA_LEADS = new Set(['CREATE', 'DROP', 'TEMP', 'TEMPORARY', 'UNIQUE'])
/**
 * 紧跟在这些词后面的 UPDATE 不是 UPDATE 语句，后面也不是表名：UPSERT 的 `ON CONFLICT ... DO UPDATE SET`，
 * 触发器的 `AFTER UPDATE [OF 列] ON {t}` / `INSTEAD OF UPDATE ON`（挂的表由后面的 ON 管）
 */
const UPDATE_NOT_STATEMENT = new Set(['DO', 'BEFORE', 'AFTER', 'OF'])
/** `CREATE TABLE IF NOT EXISTS x`：表名前允许夹这几个词 */
const NOISE = new Set(['IF', 'NOT', 'EXISTS'])
/** 能绕开表前缀或窥探整库结构，整条语句拒绝 */
const BANNED = new Set(['ATTACH', 'DETACH', 'PRAGMA'])
const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 插件名到表前缀；非法字符换成下划线，保证生成的名字是合法裸标识符 */
export function tablePrefix(plugin: string): string {
  return `p_${plugin.replace(/[^a-zA-Z0-9_]/g, '_')}_`
}

/** 扫过的一个记号。词、字面量、标点都记，回看时才分得清「紧挨着」和「中间隔了个逗号」 */
interface Token {
  raw: string
  /** 比较关键字用的大写形式；带引号的标识符和字面量是空串，标点是它自己 */
  up: string
  /** 能当名字用：标识符（含关键字，扫描器分不出来）、带引号的标识符、占位符 */
  name: boolean
  /** 只有 `)` 有：与它配对的 `(` 前面紧挨着的名字。认 `cnt(x) AS (` 这种带列清单的 CTE 要用 */
  owner?: string
}

interface Stmt {
  /** 上一个有意义的词是表关键字，下一个标识符应当是表名 */
  expectTable: boolean
  /** CREATE INDEX/TRIGGER 里 `ON` 后面跟的是表名；普通 `JOIN ... ON` 后面是连接条件 */
  onMeansTable: boolean
  sawRename: boolean
  sawColumn: boolean
  /** 本语句内定义的 CTE 名（小写）。CTE 会遮蔽同名真实表，所以放行是安全的 */
  cte: Set<string>
  /** 最近几个记号，用来回看上下文 */
  recent: Token[]
  /** 每个还没闭合的 `(` 前面紧挨着的名字（不是名字就是空串） */
  parens: string[]
}

const newStmt = (): Stmt => ({
  expectTable: false,
  onMeansTable: false,
  sawRename: false,
  sawColumn: false,
  cte: new Set(),
  recent: [],
  parens: [],
})

function fail(reason: string): never {
  throw new Error(`${reason}——插件只能操作自己的表，请用 {表名} 占位（框架会补上插件前缀）`)
}

/** `a IS [NOT] DISTINCT FROM b` 里的 FROM 是比较运算符的一部分，后面跟的是表达式，不是表 */
function isDistinctFrom(recent: Token[]): boolean {
  const n = recent.length
  if (recent[n - 1]?.up !== 'DISTINCT') return false
  return recent[n - 2]?.up === 'IS' || (recent[n - 2]?.up === 'NOT' && recent[n - 3]?.up === 'IS')
}

/**
 * @param sql 插件写的 SQL，可含多条语句（`exec` 会用到）
 * @param prefix `tablePrefix()` 的结果
 * @returns 占位符已展开的 SQL
 */
export function scopeSql(sql: string, prefix: string): string {
  const lowerPrefix = prefix.toLowerCase()
  let out = ''
  let stmt = newStmt()
  let i = 0

  const push = (token: Token): void => {
    stmt.recent.push(token)
    if (stmt.recent.length > 6) stmt.recent.shift()
  }

  while (i < sql.length) {
    const c = sql[i]!

    // ---- 注释：原样抄过去，里面的内容一概不看 ----
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl < 0 ? sql.length : nl + 1
      out += sql.slice(i, end)
      i = end
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close < 0 ? sql.length : close + 2
      out += sql.slice(i, end)
      i = end
      continue
    }

    // ---- 字符串字面量：里面的 {} 不是占位符（插件常往库里塞 JSON） ----
    if (c === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2 // '' 是转义的单引号
          else break
        } else j++
      }
      const end = Math.min(j + 1, sql.length)
      out += sql.slice(i, end)
      push({ raw: sql.slice(i, end), up: '', name: false })
      i = end
      continue
    }

    // ---- 带引号的标识符：表位置上一律拒绝，否则 "rt_installs" 就绕过去了 ----
    if (c === '"' || c === '`' || c === '[') {
      const closer = c === '[' ? ']' : c
      const close = sql.indexOf(closer, i + 1)
      const end = close < 0 ? sql.length : close + 1
      const quoted = sql.slice(i, end)
      if (stmt.expectTable) fail(`不允许用引号包住表名 ${quoted}`)
      out += quoted
      i = end
      push({ raw: quoted.replace(/^.|.$/g, ''), up: '', name: true })
      continue
    }

    // ---- 占位符 {notes} ----
    if (c === '{') {
      const close = sql.indexOf('}', i + 1)
      if (close < 0) fail('SQL 里的 { 没有配对的 }')
      const inner = sql.slice(i + 1, close)
      if (!PLACEHOLDER_NAME.test(inner)) fail(`表名占位 {${inner}} 不合法，只能是字母、数字和下划线`)
      out += prefix + inner
      i = close + 1
      stmt.expectTable = false
      push({ raw: inner, up: inner.toUpperCase(), name: true })
      continue
    }

    // ---- 标识符 / 关键字 ----
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j++
      const raw = sql.slice(i, j)
      const up = raw.toUpperCase()
      const prev = stmt.recent[stmt.recent.length - 1]

      if (BANNED.has(up)) throw new Error(`插件 SQL 不允许使用 ${up}`)

      if (stmt.expectTable && !NOISE.has(up)) {
        // 表位置上的裸标识符：要么是占位符展开的，要么是插件自己前缀下的
        // （`ctx.db.table()` 拼出来的旧写法），要么是本语句定义的 CTE
        if (!raw.toLowerCase().startsWith(lowerPrefix) && !stmt.cte.has(raw.toLowerCase())) {
          fail(`SQL 里出现了不属于本插件的表名 ${raw}`)
        }
        stmt.expectTable = false
      } else if (TABLE_KEYWORDS.has(up) || (SCHEMA_KEYWORDS.has(up) && SCHEMA_LEADS.has(prev?.up ?? ''))) {
        if (up === 'UPDATE' && UPDATE_NOT_STATEMENT.has(prev?.up ?? '')) {
          stmt.expectTable = false
        } else if (up === 'FROM' && isDistinctFrom(stmt.recent)) {
          stmt.expectTable = false
        } else {
          stmt.expectTable = true
          if (up === 'INDEX' || up === 'TRIGGER') stmt.onMeansTable = true
        }
      } else if (up === 'ON' && stmt.onMeansTable) {
        stmt.expectTable = true
      } else if (up === 'TO' && stmt.sawRename && !stmt.sawColumn) {
        // ALTER TABLE {t} RENAME TO x：改名逃出命名空间也得拦；
        // RENAME COLUMN a TO b 里的 b 是列名，不能当表名查
        stmt.expectTable = true
      } else if (!NOISE.has(up)) {
        if (up === 'RENAME') stmt.sawRename = true
        if (up === 'COLUMN') stmt.sawColumn = true
      }

      out += raw
      i = j
      push({ raw, up, name: true })
      continue
    }

    // ---- 左括号：回看 `name AS (` / `name(列, …) AS (` 判定 CTE 定义 ----
    if (c === '(') {
      const tail = [...stmt.recent]
      while (tail.length && (tail[tail.length - 1]!.up === 'MATERIALIZED' || tail[tail.length - 1]!.up === 'NOT')) tail.pop()
      if (tail.length >= 2 && tail[tail.length - 1]!.up === 'AS') {
        // AS 前面是 `)` 就是带列清单的写法，名字要取那对括号前面的词，不是括号里的最后一列
        const before = tail[tail.length - 2]!
        const name = before.up === ')' ? before.owner : before.name ? before.raw : undefined
        if (name) stmt.cte.add(name.toLowerCase())
      }
      const prev = stmt.recent[stmt.recent.length - 1]
      stmt.parens.push(prev?.name ? prev.raw : '')
      // `FROM (SELECT ...)` 是子查询，不是表名
      stmt.expectTable = false
      out += c
      i++
      push({ raw: c, up: c, name: false })
      continue
    }

    if (c === ')') {
      out += c
      i++
      push({ raw: c, up: c, name: false, owner: stmt.parens.pop() ?? '' })
      continue
    }

    if (c === ';') {
      out += c
      i++
      stmt = newStmt()
      continue
    }

    // ---- 数字字面量整个算一个记号，别把回看的窗口挤满 ----
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j]!)) j++
      const raw = sql.slice(i, j)
      out += raw
      i = j
      push({ raw, up: '', name: false })
      continue
    }

    // 其余标点也记下来：`a INTEGER UNIQUE, view INTEGER` 里 view 前面隔着逗号，不能当成紧跟 UNIQUE
    if (!/\s/.test(c)) push({ raw: c, up: c, name: false })
    out += c
    i++
  }

  return out
}

/**
 * 交给 D1 `exec()` 之前把 SQL 压成一行。
 *
 * D1 的 exec 按 `\n` 拆语句（文档原话：queries separated by `\n`）。插件用模板字符串写的
 * 多行 CREATE TABLE，第一行就是半截语句，报 `incomplete input` 且后面的全不执行——表一张都建不出来。
 * 同一行里用 `;` 分隔的多条语句它照常执行，所以把字符串以外的换行换成空格就行。
 * 运行时自己建表一直先把换行压成空格（events.ts、dedupe.ts），插件走的 ctx.db.exec 以前漏了这一步。
 *
 * 注释一并去掉：压成一行后 `--` 会把后面所有语句吞掉。引号里的换行动不得（改了就改了值），
 * 而 D1 碰到它一样会从中间拆开，所以直接报一个看得懂的错，不留给 D1 报 incomplete input。
 */
export function flattenForExec(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl < 0 ? sql.length : nl + 1
      out += ' '
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close < 0 ? sql.length : close + 2
      out += ' '
      continue
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = quotedEnd(sql, i)
      // 没配对的引号是语法错误，原样交给 D1 去报
      if (end < 0) return out + sql.slice(i)
      const quoted = sql.slice(i, end)
      if (/[\r\n]/.test(quoted)) {
        throw new Error(
          `ctx.db.exec 的 SQL 里，引号内不能换行：${quoted.slice(0, 40)}…——D1 的 exec 按行拆语句，这类值请用 ctx.db.run() 绑定参数写入`,
        )
      }
      out += quoted
      i = end
      continue
    }
    out += c === '\n' || c === '\r' ? ' ' : c
    i++
  }
  return out
}

/** start 处是开引号，返回配对引号之后的位置；没配对返回 -1。'' "" `` 是转义，[ ] 没有转义 */
function quotedEnd(sql: string, start: number): number {
  const close = sql[start] === '[' ? ']' : sql[start]!
  let j = start + 1
  while (j < sql.length) {
    if (sql[j] !== close) j++
    else if (close !== ']' && sql[j + 1] === close) j += 2
    else return j + 1
  }
  return -1
}
