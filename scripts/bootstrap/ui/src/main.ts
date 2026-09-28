import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

// 网址里的 sid 只在第一次打开时有用（换成了 Cookie），从地址栏拿掉，截图、分享都不会带出去
if (new URLSearchParams(location.search).has('sid')) history.replaceState(null, '', location.pathname)

createApp(App).mount('#app')
