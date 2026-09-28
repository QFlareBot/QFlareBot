<script setup lang="ts">
/** 粘贴 token 的输入框 + 下方实时的验证结果（第 ① 步和第 ⑤ 步共用） */
import { CircleCheck, CircleX } from 'lucide-vue-next'
import type { VerifyStatus } from '../../composables/useAutoVerify.js'
import PasswordInput from './PasswordInput.vue'
import Spinner from './Spinner.vue'

defineProps<{ id: string; label: string; placeholder: string; status: VerifyStatus; okText?: string; errorText?: string; disabled?: boolean }>()
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ paste: []; enter: [] }>()
</script>

<template>
  <div>
    <label :for="id" class="sr-only">{{ label }}</label>
    <PasswordInput
      :id="id"
      v-model="model"
      :placeholder="placeholder"
      :invalid="status === 'error'"
      :ok="status === 'ok'"
      :described-by="`${id}-status`"
      :disabled="disabled"
      @paste="emit('paste')"
      @enter="emit('enter')"
    />
    <div :id="`${id}-status`" class="mt-2 min-h-5 text-xs" aria-live="polite">
      <Transition name="swap" type="transition" mode="out-in">
        <p v-if="status === 'checking'" key="checking" class="flex items-center gap-1.5 text-fg-muted">
          <Spinner class="size-3" />正在向 Cloudflare 验证…
        </p>
        <p v-else-if="status === 'ok'" key="ok" class="flex items-center gap-1.5 font-medium text-success">
          <CircleCheck class="qb-pop size-3.5 shrink-0" aria-hidden="true" />{{ okText }}
        </p>
        <p v-else-if="status === 'error'" key="error" class="flex items-start gap-1.5 text-danger">
          <CircleX class="mt-px size-3.5 shrink-0" aria-hidden="true" /><span class="text-pretty">{{ errorText }}</span>
        </p>
        <p v-else key="idle" class="text-fg-subtle">粘贴后自动验证。Token 只经过这个页面和 Cloudflare，不会写进仓库。</p>
      </Transition>
    </div>
  </div>
</template>
