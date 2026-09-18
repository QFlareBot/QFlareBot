import { readonly, ref } from 'vue'
import type { Theme } from '@qqbot/ui-bridge'

const KEY = 'qqbot.theme'
const systemDark = matchMedia('(prefers-color-scheme: dark)')

function stored(): Theme | null {
  const t = localStorage.getItem(KEY)
  return t === 'light' || t === 'dark' ? t : null
}

const theme = ref<Theme>(stored() ?? (systemDark.matches ? 'dark' : 'light'))
const followsSystem = ref(stored() === null)

function apply() {
  if (followsSystem.value) delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme.value
}

systemDark.addEventListener('change', (e) => {
  if (followsSystem.value) theme.value = e.matches ? 'dark' : 'light'
})
apply()

export function useTheme() {
  return {
    theme: readonly(theme),
    toggle() {
      theme.value = theme.value === 'dark' ? 'light' : 'dark'
      followsSystem.value = false
      localStorage.setItem(KEY, theme.value)
      apply()
    },
  }
}
