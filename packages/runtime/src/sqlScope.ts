/**
 * 插件 SQL 的表名归一化：把 `{notes}` 换成 `p_<插件名>_notes`，并拒绝任何指向别处的表名。
 *
 * 这**不是安全边界**——插件和运行时编译进同一个 Worker、同一个 JS realm，真要使坏绕得过去。
 * 它保证的是另外两件事：插件之间不会撞表或误删，以及框架能凭前缀枚举出一个插件建过的所有表。
 * 卸载时数据清得干净，全靠后面这一点（见 purge.ts）。
 */

/** 这些关键字之后的标识符是表名（或同一命名空间下的索引/视图/触发器名） */
const TABLE_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'INDEX', 'VIEW', 'TRIGGER'])
/** `CREATE TABLE IF NOT EXISTS x`：表名前允许夹这几个词 */
const NOISE = new Set(['IF', 'NOT', 'EXISTS'])
/** 能绕开表前缀或窥探整库结构，整条语句拒绝 */
const BANNED = new Set(['ATTACH', 'DETACH', 'PRAGMA'])
const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 插件名到表前缀；非法字符换成下划线，保证生成的名字是合法裸标识符 */
export function tablePrefix(plugin: string): string {
  return `p_${plugin.replace(/[^a-zA-Z0-9_]/g, '_')}_`
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
  /** 最近几个词，用来识别 `name AS (` 形式的 CTE 定义 */
  recent: { raw: string; up: string }[]
}

const newStmt = (): Stmt => ({
  expectTable: false,
  onMeansTable: false,
  sawRename: false,
  sawColumn: false,
  cte: new Set(),
  recent: [],
})

function fail(reason: string): never {
  throw new Error(`${reason}——插件只能操作自己的表，请用 {表名} 占位（框架会补上插件前缀）`)
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

  /** 记下一个"有意义"的词，顺带识别 CTE 定义 */
  const pushWord = (raw: string, up: string): void => {
    stmt.recent.push({ raw, up })
    if (stmt.recent.length > 4) stmt.recent.shift()
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
      pushWord(quoted.replace(/^.|.$/g, ''), '')
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
      pushWord(inner, inner.toUpperCase())
      continue
    }

    // ---- 标识符 / 关键字 ----
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j++
      const raw = sql.slice(i, j)
      const up = raw.toUpperCase()

      if (BANNED.has(up)) throw new Error(`插件 SQL 不允许使用 ${up}`)

      if (stmt.expectTable && !NOISE.has(up)) {
        // 表位置上的裸标识符：要么是占位符展开的，要么是插件自己前缀下的
        // （`ctx.db.table()` 拼出来的旧写法），要么是本语句定义的 CTE
        if (!raw.toLowerCase().startsWith(lowerPrefix) && !stmt.cte.has(raw.toLowerCase())) {
          fail(`SQL 里出现了不属于本插件的表名 ${raw}`)
        }
        stmt.expectTable = false
      } else if (TABLE_KEYWORDS.has(up)) {
        // SQLite UPSERT：ON CONFLICT ... DO UPDATE SET 里的 UPDATE 不是独立的 UPDATE 语句，后面紧跟 SET 而非表名
        if (up === 'UPDATE' && stmt.recent[stmt.recent.length - 1]?.up === 'DO') {
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
      pushWord(raw, up)
      continue
    }

    // ---- 左括号：回看 `name AS (` 判定 CTE 定义 ----
    if (c === '(') {
      const tail = [...stmt.recent]
      while (tail.length && (tail[tail.length - 1]!.up === 'MATERIALIZED' || tail[tail.length - 1]!.up === 'NOT')) tail.pop()
      if (tail.length >= 2 && tail[tail.length - 1]!.up === 'AS') {
        stmt.cte.add(tail[tail.length - 2]!.raw.toLowerCase())
      }
      // `FROM (SELECT ...)` 是子查询，不是表名
      stmt.expectTable = false
      out += c
      i++
      continue
    }

    if (c === ';') {
      out += c
      i++
      stmt = newStmt()
      continue
    }

    out += c
    i++
  }

  return out
}
