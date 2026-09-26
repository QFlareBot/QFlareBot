/**
 * 插件目录（QFlareBot/plugins 仓库生成、GitHub Pages 发布的 index.json）与批量安装的顺序。
 * 字段见文档站「发布插件 → 索引格式」；schemaVersion 不变时只加字段，读不认识的字段一律忽略。
 */

export const CATALOG_INDEX_URL = 'https://qflarebot.github.io/plugins/index.json'

export interface CatalogPlugin {
  name: string
  repo: string
  subdir?: string
  /** 粘贴到安装框的地址；子目录插件带 /tree/<默认分支>/<子目录> */
  installUrl?: string
  author?: string
  displayName?: string
  description?: string
  version?: string
  tags?: string[]
  permissions?: string[]
  commands?: Array<{ name: string; description?: string }>
  /** 依赖的服务名；老索引没有这个字段 */
  depends?: string[]
  /** 提供的服务名；老索引没有这个字段 */
  services?: string[]
  durableObjects?: string[]
  license?: string | null
  stars?: number
  updatedAt?: string | null
  status?: 'ok' | 'error'
  error?: string
}

export async function fetchCatalog(url = CATALOG_INDEX_URL): Promise<CatalogPlugin[]> {
  const res = await fetch(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`读取插件目录失败：HTTP ${res.status}`)
  const data = (await res.json()) as { plugins?: unknown }
  if (!Array.isArray(data.plugins)) throw new Error('插件目录格式不对：缺少 plugins')
  return data.plugins.filter((p): p is CatalogPlugin => typeof p?.name === 'string' && typeof p?.repo === 'string')
}

export function installUrlOf(p: CatalogPlugin): string {
  return p.installUrl ?? `https://github.com/${p.repo}${p.subdir ? `/tree/HEAD/${p.subdir}` : ''}`
}

/** 批量安装里的一项：name 本身也算它提供的（后端认 depends 的键与插件同名） */
export interface BatchItem {
  name: string
  depends: string[]
  provides: string[]
}

export function batchItemOf(p: CatalogPlugin): BatchItem {
  return { name: p.name, depends: p.depends ?? [], provides: [p.name, ...(p.services ?? [])] }
}

/**
 * 同一批里的安装顺序：提供服务的排在依赖它的前面。
 *
 * 后端判断依赖时把 D1 里已写入、还没构建的也算进去，所以按这个顺序逐个写（build: false）就都能过。
 * available 是已经有人提供的（已装插件的名字与服务）。成环或依赖谁都不提供的，按原顺序排在最后，
 * 交给后端如实报错。
 */
export function installOrder<T extends BatchItem>(items: readonly T[], available: ReadonlySet<string>): T[] {
  const provided = new Set(available)
  const ordered: T[] = []
  let rest = [...items]
  while (rest.length > 0) {
    const ready = rest.filter((i) => i.depends.every((d) => provided.has(d)))
    if (ready.length === 0) return [...ordered, ...rest]
    for (const i of ready) {
      ordered.push(i)
      for (const p of i.provides) provided.add(p)
    }
    rest = rest.filter((i) => !ready.includes(i))
  }
  return ordered
}

/**
 * 预检报了「依赖未满足」，缺的是不是都由同一批里的其他插件提供。
 * 预检不写 D1：同一批里排在后面的插件预检时看不到前面的，是真缺还是等一下就有，要在这里分开。
 */
export function dependsCoveredByBatch(item: BatchItem, batch: readonly BatchItem[], available: ReadonlySet<string>): boolean {
  const fromBatch = new Set(batch.filter((b) => b.name !== item.name).flatMap((b) => b.provides))
  return item.depends.length > 0 && item.depends.every((d) => available.has(d) || fromBatch.has(d))
}
