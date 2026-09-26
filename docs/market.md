---
aside: false
---

<script setup>
import PluginMarket from './.vitepress/components/PluginMarket.vue'
</script>

# 插件市场

登记在[插件目录](https://github.com/QFlareBot/plugins)里的插件。填上你的机器人地址，点「安装」或勾选几个一起装，会打开你面板里的「市场」页，在那里逐个预检、确认；一次装几个都只构建一次。面板里的「市场」页也能直接浏览、安装同一份目录。

目录只检查插件能构建、名字不冲突，不是安全审核：插件与框架核心同在一个 isolate、没有沙箱，装之前请自己看一眼仓库。想把自己的插件放进来，见[发布插件](./publish.md)。

<PluginMarket />
