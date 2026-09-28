import { useConfirm } from '@panel/composables/useConfirm.js'
import { computed, ref } from 'vue'
import { useWizard } from '../wizard.js'

/** 终止 / 关闭向导：部署完之前是「终止」（危险），完成之后是「关闭」 */
export function useLeave() {
  const w = useWizard()
  const confirm = useConfirm()
  const busy = ref(false)
  const finished = computed(() => !!w.completion.value)

  async function leave() {
    const ok = await confirm(
      finished.value
        ? {
            title: '现在关闭向导？',
            message: '工作流会立即结束并释放 GitHub Actions Runner。这一页上的地址之后可以到 Cloudflare 后台查。',
            confirmText: '关闭向导',
          }
        : {
            title: '终止部署向导？',
            message: '工作流会停止并释放 GitHub Actions Runner。已经建好的资源和部署都会保留，重跑 Bootstrap 可以接着来。',
            confirmText: '终止向导',
            danger: true,
          },
    )
    if (!ok) return
    busy.value = true
    try {
      if (finished.value) await w.exitWizard()
      else await w.cancelWizard()
    } finally {
      busy.value = false
    }
  }

  return { leave, busy, finished }
}
