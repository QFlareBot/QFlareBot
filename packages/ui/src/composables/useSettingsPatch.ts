import { ref } from 'vue'
import { api, type SettingsPatch } from '../api/client.js'
import { useStatus } from './useStatus.js'
import { useToast } from './useToast.js'

/** 设置页各分区共用：只把改了的字段交给服务端合并 */
export function useSettingsPatch() {
  const { refresh } = useStatus()
  const { push } = useToast()
  const saving = ref(false)

  async function save(patch: Partial<Record<keyof SettingsPatch, unknown>>): Promise<boolean> {
    saving.value = true
    try {
      // 以前读整份快照再 PUT 回去，两次往返之间别处保存的插件配置会被盖掉。
      // 值是 undefined 的字段（比如清空了权限不足回复）换成 null，JSON 里才留得住「清掉」这个意思
      const body: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) body[key] = value === undefined ? null : value
      await api.patchSettings(body as SettingsPatch)
      await refresh()
      push('已保存', 'success')
      return true
    } catch (e) {
      push(`保存失败：${(e as Error).message}`, 'error')
      return false
    } finally {
      saving.value = false
    }
  }

  return { saving, save }
}
