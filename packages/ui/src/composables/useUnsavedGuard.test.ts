import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { provideUnsavedGuard } from './useUnsavedGuard.js'

const hooks = vi.hoisted(() => ({
  mounted: [] as Array<() => void>,
  unmounted: [] as Array<() => void>,
  leave: vi.fn(),
  update: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock('vue', () => ({
  provide: vi.fn(),
  inject: vi.fn(),
  onMounted: (fn: () => void) => hooks.mounted.push(fn),
  onBeforeUnmount: (fn: () => void) => hooks.unmounted.push(fn),
}))
vi.mock('vue-router', () => ({ onBeforeRouteLeave: hooks.leave, onBeforeRouteUpdate: hooks.update }))
vi.mock('./useConfirm.js', () => ({ useConfirm: () => hooks.confirm }))

beforeEach(() => {
  vi.resetAllMocks()
  hooks.mounted.length = 0
  hooks.unmounted.length = 0
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('页面自身草稿守卫', () => {
  it('动态读取桥接状态，取消保留页面，保存完成后直接离开', async () => {
    let dirty = true
    provideUnsavedGuard(() => dirty)
    const leave = hooks.leave.mock.calls[0]![0]
    hooks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    expect(await leave()).toBe(false)
    expect(await leave()).toBe(true)
    dirty = false
    expect(await leave()).toBe(true)
    expect(hooks.confirm).toHaveBeenCalledTimes(2)
  })

  it('切换插件路径检查草稿，同一路径切换查询参数不拦截', async () => {
    provideUnsavedGuard(() => true)
    const update = hooks.update.mock.calls[0]![0]
    hooks.confirm.mockResolvedValue(false)
    expect(await update({ path: '/plugin-ui/llm' }, { path: '/plugin-ui/agent' })).toBe(false)
    expect(await update({ path: '/plugin-ui/llm' }, { path: '/plugin-ui/llm' })).toBe(true)
    expect(hooks.confirm).toHaveBeenCalledTimes(1)
  })

  it('在顶层窗口拦截刷新，并在清除草稿或卸载后释放', () => {
    let dirty = true
    provideUnsavedGuard(() => dirty)
    hooks.mounted.forEach((fn) => fn())
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(unload()).toBe(true)
    dirty = false
    expect(unload()).toBe(false)
    dirty = true
    hooks.unmounted.forEach((fn) => fn())
    expect(unload()).toBe(false)
  })
})
