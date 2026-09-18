import { computed, ref } from 'vue'
import { api, session, setUnauthorizedHandler } from '../api/client.js'

const token = ref(session.get())

export function useAuth() {
  return {
    loggedIn: computed(() => !!token.value),
    async login(adminToken: string) {
      const { session: s } = await api.login(adminToken)
      session.set(s)
      token.value = s
    },
    logout() {
      session.clear()
      token.value = null
    },
  }
}

/** API 返回 401 时同步状态，路由守卫会把用户送回登录页 */
export function installAuthHandler(onLogout: () => void): void {
  setUnauthorizedHandler(() => {
    token.value = null
    onLogout()
  })
}
