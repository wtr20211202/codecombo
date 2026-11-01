<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'

/**
 * 远程文件右键菜单（teleport 到 body，全屏透明层接管外部点击）。
 * 自绘而非 NDropdown manual 模式：后者在虚拟滚动容器内触发时机不稳定。
 * 弹出位置做视口收敛：贴近屏幕底部/右缘时向内收，避免菜单被裁剪。
 */
const props = defineProps<{
  x: number
  y: number
  options: { key: string; label: string; danger?: boolean }[]
}>()

const emit = defineEmits<{
  (e: 'select', key: string): void
  (e: 'close'): void
}>()

const menuRef = ref<HTMLElement | null>(null)
const pos = ref({ x: props.x, y: props.y })

function clamp() {
  const el = menuRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  if (pos.value.x + r.width > window.innerWidth - 8) {
    pos.value.x = Math.max(8, window.innerWidth - r.width - 8)
  }
  if (pos.value.y + r.height > window.innerHeight - 8) {
    pos.value.y = Math.max(8, window.innerHeight - r.height - 8)
  }
}

onMounted(clamp)
watch(() => [props.x, props.y], () => {
  pos.value = { x: props.x, y: props.y }
  // 等菜单按新尺寸渲染后收敛
  requestAnimationFrame(clamp)
})

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <teleport to="body">
    <div
      class="rfc-overlay"
      @mousedown.prevent="emit('close')"
      @contextmenu.prevent="emit('close')"
    >
      <div
        ref="menuRef"
        class="rfc-menu"
        :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
        @click.stop
        @mousedown.stop
      >
        <button
          v-for="o in options"
          :key="o.key"
          class="rfc-item"
          :class="{ 'is-danger': o.danger }"
          @click="emit('select', o.key)"
        >
          <span>{{ o.label }}</span>
        </button>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.rfc-overlay {
  position: fixed;
  inset: 0;
  z-index: 100000;
}
.rfc-menu {
  position: fixed;
  min-width: 150px;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 4px;
  box-shadow: var(--shadow-pop);
  user-select: none;
}
.rfc-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  background: none;
  color: var(--text-body);
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  text-align: left;
}
.rfc-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.rfc-item.is-danger { color: var(--accent-red); }
</style>
