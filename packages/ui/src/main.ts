import { createApp } from 'vue'
import App from './App.vue'
import { installAuthHandler } from './composables/useAuth.js'
import { router } from './router.js'
import './styles.css'

installAuthHandler(() => void router.replace({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } }))

createApp(App).use(router).mount('#app')
