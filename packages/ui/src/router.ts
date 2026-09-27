import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuth } from './composables/useAuth.js'

/** hash 路由：与 Worker 的保留路径（/webhook、/admin、/p）互不干扰，且不需要 SPA 回退 */
export const router = createRouter({
  history: createWebHashHistory(),
  // 等旧页淡出（AppShell 里的 160ms）再滚，免得旧页先跳到顶上再消失；前进后退回到原来的位置。
  // 同一页只换查询参数（页内标签）不滚
  scrollBehavior: (to, from, saved) =>
    to.path === from.path && !saved ? false : new Promise((resolve) => setTimeout(() => resolve(saved ?? { top: 0 }), 160)),
  routes: [
    { path: '/login', component: () => import('./pages/LoginPage.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('./components/AppShell.vue'),
      children: [
        { path: '', component: () => import('./pages/OverviewPage.vue') },
        { path: 'plugins', component: () => import('./pages/PluginsPage.vue') },
        { path: 'plugins/:name', component: () => import('./pages/PluginDetailPage.vue') },
        // 「添加插件」（插件市场 + 仓库链接）。不放在 plugins/ 下面：会和同名插件的详情页撞路由；
        // 路径保持 /market，文档站的「安装」按钮跳的是 /#/market?install=a,b
        { path: 'market', component: () => import('./pages/AddPluginPage.vue') },
        { path: 'plugin-ui/:name', component: () => import('./pages/PluginUiPage.vue') },
        { path: 'storage', component: () => import('./pages/StoragePage.vue') },
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
