<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ value: unknown }>()
const text = computed(() => (typeof props.value === 'string' ? props.value : JSON.stringify(props.value, null, 2)))
</script>

<template>
  <pre class="max-h-80 overflow-auto rounded-md border border-border bg-surface-muted p-3 font-mono text-xs leading-relaxed text-fg"><code>{{ text }}</code></pre>
</template>
