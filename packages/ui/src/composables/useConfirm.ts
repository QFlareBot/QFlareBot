import { shallowRef } from 'vue'

/** 代替浏览器的 confirm()：危险操作用红色按钮，能带一条补充警告和一个勾选项 */
export interface ConfirmOptions {
  title: string
  message?: string
  /** 显示在正文下面的黄色提示，例如「有插件依赖它」 */
  warning?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  /** 附带的勾选项（如「同时清空数据」），默认不勾 */
  checkbox?: { label: string; hint?: string }
}

/** 确认返回勾选状态；取消返回 null */
export interface ConfirmResult {
  checked: boolean
}

interface Pending extends ConfirmOptions {
  resolve: (result: ConfirmResult | null) => void
}

const pending = shallowRef<Pending | null>(null)

/** 页面里调用：`const ok = await confirm({ ... }); if (!ok) return` */
export function useConfirm(): (options: ConfirmOptions) => Promise<ConfirmResult | null> {
  return (options) =>
    new Promise((resolve) => {
      // 上一个还开着就当取消：同一时刻只问一件事
      pending.value?.resolve(null)
      pending.value = { ...options, resolve }
    })
}

/** 给 ConfirmHost 用 */
export function useConfirmHost() {
  return {
    pending,
    settle(result: ConfirmResult | null) {
      const p = pending.value
      pending.value = null
      p?.resolve(result)
    },
  }
}
