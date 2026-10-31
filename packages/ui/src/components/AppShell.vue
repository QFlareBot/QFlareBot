<script setup lang="ts">
/**
 * 布局：桌面左侧是浮在底色上的半透明侧栏；手机是顶栏 + 左侧抽屉。
 * 普通页面跟着文档滚动；插件页面独占剩余视口，只让 iframe 的文档滚动。
 */
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import MobileBar from './shell/MobileBar.vue'
import NavDrawer from './shell/NavDrawer.vue'
import SidePanel from './shell/SidePanel.vue'

const drawerOpen = ref(false)
const route = useRoute()
const embeddedPage = computed(() => route.meta.embeddedPage === true)
</script>

<template>
  <div class="app-shell md:flex" :class="{ 'app-shell--embedded': embeddedPage }">
    <aside class="sticky top-0 hidden h-dvh w-60 shrink-0 p-3 pr-0 md:block">
      <div class="qb-glass h-full overflow-hidden rounded-[18px] shadow-card"><SidePanel /></div>
    </aside>

    <MobileBar class="md:hidden" :open="drawerOpen" @menu="drawerOpen = true" />
    <NavDrawer v-model:open="drawerOpen"><SidePanel @navigate="drawerOpen = false" /></NavDrawer>

    <main class="app-main min-w-0 flex-1">
      <div
        class="app-content mx-auto max-w-6xl pt-5 pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+2.5rem)] pl-[max(1rem,env(safe-area-inset-left))] md:px-8 md:pt-8"
      >
        <!-- 子元素错落上浮的动画比根元素长，给足总时长，免得类名被提前摘掉 -->
        <RouterView v-slot="{ Component, route }">
          <!-- iframe 不参与离场/进场搬移，防止加载中的文档被重置为空白页；插件间复用宿主。 -->
          <component v-if="route.meta.embeddedPage" :is="Component" key="plugin-ui" />
          <Transition v-else name="page" mode="out-in" :duration="{ enter: 700, leave: 160 }">
            <component :is="Component" :key="route.path" />
          </Transition>
        </RouterView>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* min-height: 0 on every flex ancestor prevents long iframe content from expanding the shell. */
.app-shell--embedded {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
}
.app-shell--embedded > header { flex-shrink: 0; }
.app-shell--embedded .app-main {
  display: flex;
  min-height: 0;
  overflow: hidden;
}
.app-shell--embedded .app-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  width: 100%;
  padding-top: var(--qb-space-3);
  padding-bottom: max(var(--qb-space-3), env(safe-area-inset-bottom));
  overflow: hidden;
}
@media (min-width: 768px) {
  .app-shell--embedded { flex-direction: row; }
}
</style>
