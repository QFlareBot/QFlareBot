/** 管理端点取 D1 绑定：没绑定返回 null，503 与「缺了什么」的文案由各端点自己给 */
import type { RequestScope } from './scope.js'

export async function requireDb(scope: RequestScope): Promise<D1Database | null> {
  if (!scope.env.DB) return null
  return scope.env.DB
}
