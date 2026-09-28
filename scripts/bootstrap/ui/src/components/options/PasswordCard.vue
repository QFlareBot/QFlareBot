<script setup lang="ts">
/**
 * 面板登录密码。重跑且 Worker 上已经有一个时，可以选择沿用（密码不变、已登录的会话照常有效）；
 * 否则必填，带长度进度条。
 */
import QCollapse from '@panel/components/ui/QCollapse.vue'
import { computed } from 'vue'
import type { PasswordMode } from '../../types.js'
import ChoiceCards from '../base/ChoiceCards.vue'
import PasswordInput from '../base/PasswordInput.vue'
import StepCard from '../base/StepCard.vue'

const props = defineProps<{ min: number; allowKeep: boolean; error?: string }>()
const password = defineModel<string>('password', { required: true })
const mode = defineModel<PasswordMode>('mode', { required: true })
const emit = defineEmits<{ submit: [] }>()

const MODES = [
  { value: 'keep' as const, title: '保留原来的密码', description: '密码不变，面板里已经登录的也不用重新登录。' },
  { value: 'new' as const, title: '设一个新密码', description: '改了之后，已登录的地方都要用新密码重新登录。' },
]
const length = computed(() => password.value.trim().length)
const longEnough = computed(() => length.value >= props.min)
const needsInput = computed(() => !props.allowKeep || mode.value === 'new')
</script>

<template>
  <StepCard
    title="面板登录密码"
    :description="
      allowKeep ? '这个 Worker 上已经设过一个，可以直接沿用。' : '也就是 ADMIN_TOKEN。引导不保存、不回显；忘了可以到 Cloudflare 的 Worker 设置里改这个变量。'
    "
  >
    <ChoiceCards v-if="allowKeep" v-model="mode" name="admin-mode" :options="MODES" />
    <QCollapse :open="needsInput">
      <div :class="allowKeep && 'pt-4'">
        <label for="admin-token" class="sr-only">面板登录密码</label>
        <PasswordInput
          id="admin-token"
          v-model="password"
          autocomplete="new-password"
          :placeholder="`至少 ${min} 个字符`"
          :invalid="!!error && needsInput"
          :ok="longEnough"
          described-by="admin-token-meter"
          @enter="emit('submit')"
        />
        <div id="admin-token-meter" class="mt-2.5 flex items-center gap-3">
          <span class="h-1 flex-1 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
            <span
              class="block h-full origin-left rounded-full transition-[transform,background-color] duration-(--qb-duration-slow) ease-out"
              :class="longEnough ? 'bg-success' : 'bg-accent/50'"
              :style="{ transform: `scaleX(${Math.min(1, length / min)})` }"
            />
          </span>
          <span class="text-xs tabular-nums" :class="longEnough ? 'text-success' : 'text-fg-subtle'">{{ longEnough ? '长度够了' : `${length} / ${min}` }}</span>
        </div>
      </div>
    </QCollapse>
    <p v-if="error" class="mt-2 text-xs text-danger" role="alert">{{ error }}</p>
  </StepCard>
</template>
