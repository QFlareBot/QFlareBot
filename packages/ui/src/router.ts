import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuth } from './composables/useAuth.js'

/** hash 路由：与 Worker 的保留路径（/webhook、/admin、/p）互不干扰，且不需要 SPA 回退 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: () => import('./pages/LoginPage.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('./components/AppShell.vue'),
      children: [
        { path: '', component: () => import('./pages/OverviewPage.vue') },
        { path: 'plugins', component: () => import('./pages/PluginsPage.vue') },
        { path: 'plugins/:name', component: () => import('./pages/PluginDetailPage.vue') },
        { path: 'plugin-ui/:name', component: () => import('./pages/PluginUiPage.vue') },
        { path: 'debug', component: () => import('./pages/DebugPage.vue') },
        { path: 'settings', component: () => import('./pages/SettingsPage.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach((to) => {
  const { loggedIn } = useAuth()
  if (!to.meta.public && !loggedIn.value) return { path: '/login', query: { redirect: to.fullPath } }
  if (to.path === '/login' && loggedIn.value) return '/'
  return true
})
