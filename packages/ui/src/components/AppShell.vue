<script setup lang="ts">
/**
 * 布局：桌面左侧是浮在底色上的半透明侧栏；手机是顶栏 + 左侧抽屉。
 * 页面跟着文档滚动（不是某个内层容器），手机浏览器的地址栏才能随滚动收起。
 */
import { ref } from 'vue'
import MobileBar from './shell/MobileBar.vue'
import NavDrawer from './shell/NavDrawer.vue'
import SidePanel from './shell/SidePanel.vue'

const drawerOpen = ref(false)
</script>

<template>
  <div class="md:flex">
    <aside class="sticky top-0 hidden h-dvh w-60 shrink-0 p-3 pr-0 md:block">
      <div class="qb-glass h-full overflow-hidden rounded-[18px] shadow-card"><SidePanel /></div>
    </aside>

    <MobileBar class="md:hidden" :open="drawerOpen" @menu="drawerOpen = true" />
    <NavDrawer v-model:open="drawerOpen"><SidePanel @navigate="drawerOpen = false" /></NavDrawer>

    <main class="min-w-0 flex-1">
      <div
        class="mx-auto max-w-6xl pt-5 pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+2.5rem)] pl-[max(1rem,env(safe-area-inset-left))] md:px-8 md:pt-8"
      >
        <!-- 子元素错落上浮的动画比根元素长，给足总时长，免得类名被提前摘掉 -->
        <RouterView v-slot="{ Component, route }">
          <Transition name="page" mode="out-in" :duration="{ enter: 700, leave: 160 }">
            <component :is="Component" :key="route.path" />
          </Transition>
        </RouterView>
      </div>
    </main>
  </div>
</template>
