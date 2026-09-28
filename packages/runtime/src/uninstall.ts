/**
 * 卸载：DELETE /admin/manifest/plugins/:name 当场做完能做的（钩子、删清单、记账本、触发构建、尽力清数据），
 * 剩下的由 Cron 等插件真的不在部署里了再收尾（processPendingCleanups，待收尾记在 rt_pending_cleanups）。
 */
import { requireDb } from './adminDb.js'
import { BUILD_DEFERRED, buildAfterChange } from './buildTrigger.js'
import { error, json } from './http.js'
import { dependentsOf, knownManifests } from './installChecks.js'
import {
  addPendingCleanup,
  deleteManifestPlugin,
  getManifestPlugin,
  insertInstall,
  listManifestPluginRecords,
  listManifestPlugins,
  listPendingCleanups,
  manifestHash,
  removePendingCleanup,
  type PendingCleanup,
} from './manifestStore.js'
import {
  clearInstallMarker,
  describeRemaining,
  knownPluginNames,
  purgeComplete,
  purgePluginData,
  runUninstallHook,
  type HookReport,
  type PurgeReport,
} from './purge.js'
import { readSnapshot, writeSnapshot } from './store.js'
import type { RequestScope } from './scope.js'
import type { AdminDeps } from './admin.js'
import type { RuntimeEnv } from './types.js'

// ---------- 卸载 ----------

/**
 * DELETE /admin/manifest/plugins/:name[?purge=true][&build=false]
 *
 * 数据默认**保留**：卸载多半是不想要了，但误删不可逆，而留下的数据在
 * `GET /admin/storage` 里会被标成孤儿，随时可以清——比默认删安全，又不至于管不了。
 *
 * D1 里有、但从没真正装上（构建失败）的插件同样走这里：它不在部署里，没有 onUninstall 可跑；
 * 删掉之后 D1 就和线上一致了，不会白触发一次构建。
 *
 * 顺序：钩子 → 删清单 → 记待清理 → 删 onInstall 标记 → 记账本、触发构建 → **最后**尽力清数据。
 * 清数据一次只删一批（见 purge.ts），键多就删不完，也可能撞上单次调用的操作数上限而抛错——超了之后
 * 同一次调用里再碰任何绑定都会失败。以前清数据排在删清单之前，一抛就是笼统的 500：钩子跑了、数据删了一半、
 * 清单还在，定时收尾每分钟再撞一次。现在必须做成的几步都排在它前面，清数据的错误接住放进 `data.purgeError`，
 * 没删完的由 `rt_pending_cleanups` 在新版本上线后接着删。
 */
export async function uninstallManifestPlugin(
  name: string,
  purgeData: boolean,
  scope: RequestScope,
  deps: AdminDeps,
  opts: { build?: boolean } = {},
): Promise<Response> {
  const db = await requireDb(scope)
  if (!db) return error('未绑定 D1，无法卸载插件', 503)

  const existing = await getManifestPlugin(db, name)
  if (!existing) {
    const bundled = deps.registry.get(name)
    return error(bundled ? '该插件由仓库清单内置：请从 qqbot.manifest.json 移除后重新构建' : `未安装：${name}`, 404)
  }

  const records = await listManifestPluginRecords(db)
  const dependents = dependentsOf(name, knownManifests(records, deps.registry))
  const warnings: string[] = []
  if (dependents.length > 0) warnings.push(`这些插件依赖它提供的服务，卸载后调用会报错：${dependents.join('、')}`)

  const registered = deps.registry.get(name)
  // D1 里这份同名覆盖从没上线，线上跑的是仓库内置的那一份：钩子、onInstall 标记、数据都是内置插件的，一样都不能动——
  // 跑它的 onUninstall、删它的标记、清它正在用的数据，等于把一个没打算卸的插件卸了一半。也不记待清理：
  // 那一行要等「插件不在部署里」，内置插件一直在，只会永远挂着。没有出处信息的老部署分不出来，照旧。
  const liveIsBuiltin = registered?.origin?.from === 'repo'

  // 趁插件代码还在这次部署里，先让它自己收尾；重建之后就没机会了
  const { hook, hookError }: HookReport =
    registered && !liveIsBuiltin ? await runUninstallHook(registered, scope.contexts, purgeData, deps.logger) : { hook: 'none' }

  await deleteManifestPlugin(db, name)
  if (liveIsBuiltin) {
    warnings.push(
      `线上跑的是同名的仓库内置插件 ${name}（这份覆盖还没上线过），撤掉之后它照常运行：没有运行 onUninstall` +
        `${purgeData ? '，也没有清数据——数据归内置插件' : ''}`,
    )
  } else {
    // 后半段：重建完成前旧代码还在跑，冷启动的 isolate 读不到标记会重跑 onInstall，把表建回来、
    // 把标记写回去（以后重装 onInstall 就静默不跑了）。等插件真的不在部署里了，由定时任务再收一次尾；
    // 这一趟没删完的数据也由它接着删
    await addPendingCleanup(db, name, purgeData)
    // 标记无条件删：数据清了，重装必须重新建表；数据留着，onInstall 本来就要求幂等
    await clearInstallMarker(name, scope.env)
  }
  const hash = await manifestHash(await listManifestPlugins(db))
  const install = await insertInstall(db, { action: 'uninstall', name, source: existing.source, manifestHash: hash, status: 'pending' })

  // 就地触发构建：只改 D1 清单的话，插件还留在正在运行的 bundle 里——卸载等于没生效。
  // 触发失败不回滚卸载（清单已经改了，回滚只会更乱），如实报出来让用户手动重试。
  const build = opts.build === false ? BUILD_DEFERRED : await buildAfterChange(scope, deps, hash)

  let purged: PurgeReport | null = null
  let purgeError: string | undefined
  if (purgeData && !liveIsBuiltin) {
    try {
      // 与清孤儿、卸载收尾同一份「已知插件名」：表前缀可能碰撞或嵌套，名单越全越不会误删邻居
      purged = await purgePluginData(name, scope.env, await knownPluginNames(scope.env, deps.registry))
    } catch (err) {
      purgeError = err instanceof Error ? err.message : String(err)
      deps.logger.warn('卸载时清数据没做完，新版本上线后由定时任务接着清', { plugin: name, error: purgeError })
    }
    const remaining = purged ? describeRemaining(purged) : null
    if (purgeError) warnings.push(`清数据中途出错（${purgeError}）：卸载本身已生效，新版本上线后定时任务会接着清`)
    else if (remaining) warnings.push(`数据还没清完（${remaining}，一次只清一批）：新版本上线后定时任务会接着清`)
  }

  return json({
    ok: true,
    removed: existing,
    hash,
    install,
    build,
    data: {
      // 线上是内置插件时选了清数据也没清，如实报 false
      purged: purgeData && !liveIsBuiltin,
      hook,
      ...(hookError ? { hookError } : {}),
      ...(purged ?? {}),
      ...(purgeError ? { purgeError } : {}),
      ...(liveIsBuiltin ? { liveIsBuiltin: true } : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}

/**
 * 连同配置、优先级、启用状态、面板上选它提供的服务一起从快照里拿掉（卸载时选了清数据才走到这里）。
 * 选择不清也不会出错（选的插件不再提供就回落默认），只是重装回来时会悄悄重新生效
 */
async function dropPluginState(env: RuntimeEnv, name: string): Promise<void> {
  const snapshot = await readSnapshot(env, true)
  const chosen = Object.entries(snapshot.serviceProviders ?? {}).filter(([, provider]) => provider === name)
  if (!(name in snapshot.plugins) && chosen.length === 0) return
  const plugins = { ...snapshot.plugins }
  delete plugins[name]
  const next = { ...snapshot, plugins }
  if (chosen.length > 0) {
    const serviceProviders = Object.fromEntries(Object.entries(snapshot.serviceProviders ?? {}).filter(([, p]) => p !== name))
    if (Object.keys(serviceProviders).length > 0) next.serviceProviders = serviceProviders
    else delete next.serviceProviders
  }
  await writeSnapshot(env, next)
}

/**
 * 卸载的后半段，由 Cron 调用：等插件真的不在这份部署里了，再删一遍 onInstall 标记，按需再清一遍数据。
 *
 * 卸载请求当场已经清过一次，但重建完成前旧代码还在跑——冷启动的 isolate 读不到标记会重跑 onInstall，
 * 把表建回来、把标记写回去，以后重装时 onInstall 就静默不跑了。在旧代码没机会再动之后收尾，
 * 这两件事才靠得住。插件还在部署里（重建没完成、构建失败）就等下一次；清数据还会连快照里的配置一起清。
 *
 * 清数据一次只删一批（见 purge.ts），没删完就留着这一行，下一分钟接着删；每次 Cron 最多清一个插件的数据——
 * 一批的操作数是按单次调用的上限估的，两个插件一起删就可能超。每项单独接住错误，一个失败不挡别的。
 *
 * 另一种就绪：D1 里装过一份与仓库内置插件同名的覆盖，卸掉之后内置的回来了（注册表里是 repo 来源、D1 清单里已经没有它）。
 * 这时插件永远「在部署里」，按老规则这一行永远等不到。数据现在归正在运行的内置插件，一样都不清；
 * 只再删一次标记——覆盖那一份的代码交接时可能写过它，而 onInstall 本来就要求幂等，让内置的重跑一遍无害。
 */
export async function processPendingCleanups(scope: RequestScope, deps: AdminDeps): Promise<void> {
  const db = scope.env.DB
  if (!db) return
  type Ready = PendingCleanup & { builtinBack: boolean }
  let pending: PendingCleanup[]
  let ready: Ready[]
  try {
    pending = await listPendingCleanups(db)
    if (pending.length === 0) return
    const builtin = pending.filter((c) => deps.registry.get(c.name)?.origin?.from === 'repo')
    // 只有碰上内置插件时才需要读 D1 清单
    const inD1 = builtin.length > 0 ? new Set((await listManifestPlugins(db)).map((p) => p.name)) : new Set<string>()
    ready = pending.flatMap((c): Ready[] => {
      const live = deps.registry.get(c.name)
      if (!live) return [{ ...c, builtinBack: false }]
      return live.origin?.from === 'repo' && !inD1.has(c.name) ? [{ ...c, builtinBack: true }] : []
    })
  } catch (err) {
    deps.logger.warn('卸载收尾失败，下次定时任务再试', { error: err instanceof Error ? err.message : String(err) })
    return
  }
  if (ready.length === 0) return

  // 与卸载清数据、清孤儿同一份「已知插件名」：表前缀可能碰撞或嵌套，名单越全越不会误删邻居。
  // 在动手之前取，并把这次读到的待收尾名字都并进去——同一轮里排在前面的项收完尾就删了自己那一行，
  // 之后再读就少了它，它留下的表会被当成别人的 DROP 掉
  let known: Set<string> | null = null
  try {
    if (ready.some((c) => c.purge && !c.builtinBack)) {
      known = await knownPluginNames(scope.env, deps.registry)
      for (const c of pending) known.add(c.name)
    }
  } catch (err) {
    deps.logger.warn('卸载收尾失败，下次定时任务再试', { error: err instanceof Error ? err.message : String(err) })
    return
  }

  let purgedOne = false
  for (const c of ready) {
    try {
      if (c.builtinBack) {
        await clearInstallMarker(c.name, scope.env)
        await removePendingCleanup(db, c.name)
        deps.logger.info('卸载收尾完成：内置插件已回来，只删了标记、没清数据', { plugin: c.name })
        continue
      }
      if (c.purge) {
        if (purgedOne || !known) continue
        await clearInstallMarker(c.name, scope.env)
        const report = await purgePluginData(c.name, scope.env, known)
        // 删成了才占掉这一轮的名额：抛错的那个不该一直挡着后面的
        purgedOne = true
        if (!purgeComplete(report)) {
          deps.logger.info('卸载收尾：数据还没清完，下一分钟接着清', { plugin: c.name, remaining: describeRemaining(report) })
          continue
        }
        await dropPluginState(scope.env, c.name)
      } else {
        await clearInstallMarker(c.name, scope.env)
      }
      await removePendingCleanup(db, c.name)
      deps.logger.info('卸载收尾完成', { plugin: c.name, purge: c.purge })
    } catch (err) {
      deps.logger.warn('卸载收尾失败，下次定时任务再试', { plugin: c.name, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
