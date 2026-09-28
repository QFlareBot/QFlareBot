<script setup lang="ts">
import ConfirmHost from '@panel/components/ConfirmHost.vue'
import { onMounted } from 'vue'
import EndScreen from './components/shell/EndScreen.vue'
import LoadingScreen from './components/shell/LoadingScreen.vue'
import WizardShell from './components/shell/WizardShell.vue'
import { useWizard } from './wizard.js'

const w = useWizard()
onMounted(() => void w.load())
</script>

<template>
  <Transition name="fade" mode="out-in">
    <EndScreen v-if="w.ended.value" :key="w.ended.value" :kind="w.ended.value" />
    <div v-else-if="w.init.value" key="wizard"><WizardShell /></div>
    <LoadingScreen v-else key="loading" :error="w.loadError.value" @retry="w.load()" />
  </Transition>
  <ConfirmHost />
</template>
