<script setup lang="ts">
import ConfirmHost from './components/ConfirmHost.vue'
import Toaster from './components/Toaster.vue'
</script>

<template>
  <RouterView />
  <Toaster />
  <ConfirmHost />
</template>
