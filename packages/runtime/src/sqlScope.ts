/**
 * 插件 SQL 的表名归一化：把 `{notes}` 换成 `p_<插件名>_notes`，并拒绝任何指向别处的表名。
 *
 * 这**不是安全边界**——插件和运行时编译进同一个 Worker、同一个 JS realm，真要使坏绕得过去。
 * 它保证的是另外两件事：插件之间不会撞表或误删，以及框架能凭前缀枚举出一个插件建过的所有表。
 * 卸载时数据清得干净，全靠后面这一点（见 purge.ts）。
 *
 * 扫描器本身在 SDK 里（@qqbot/sdk/sqlScope）：`@qqbot/sdk/testing` 的 mock ctx.db 要和线上走同一套规则，
 * 而 SDK 不能依赖运行时。这里原样重新导出，运行时各处照旧从 ./sqlScope.js 取；只有运行时用得上的留在这里。
 */
import { tablePrefix } from '@qqbot/sdk/sqlScope'

export { flattenForExec, scopeSql, tablePrefix } from '@qqbot/sdk/sqlScope'

/**
 * 两个插件名是否落到同一个表前缀。
 *
 * `tablePrefix` 把非字母数字一律换成 `_`，于是 `my-plugin` 与 `my_plugin` 都得到 `p_my_plugin_`。
 * 这不是可以放过的巧合：卸载其中一个会按前缀把另一个的表一起 `DROP` 掉，且不可逆。
 * 所以安装时拒绝这种组合，清理时也要再确认一遍归属（见 purge.ts）。
 */
export function prefixesCollide(a: string, b: string): boolean {
  return a !== b && tablePrefix(a) === tablePrefix(b)
}
