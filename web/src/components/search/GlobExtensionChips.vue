<script setup lang="ts">
// 扩展名快选 chips（P-20261003-148）：.ts/.md/.json/.go 一键预填 glob=*.ext——
// 「只搜某类文件」是高频范围意图，不该被 glob 语法（*.md 手写）挡住。与宿主
// glob 输入双向联动：active 态由 pattern 派生（与 *.ext 精确等值才点亮），
// 手改 glob 偏离即熄灭、改回即点亮；本组件不持有过滤状态（glob 输入是唯一
// 事实源，chips 之外的自定义模式仍由 glob 框兜底）。搜索触发交给宿主的既有
// watch(filePattern)，点选即预填即重搜。
import { computed } from 'vue'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  /** 宿主 glob 过滤值（唯一事实源，本组件只派生高亮并回写预填） */
  pattern: string
}>()
const emit = defineEmits<{
  (e: 'update:pattern', val: string): void
}>()

const { t } = useI18n()

// 高频扩展名（任务书指定）；`.ts` 等字面量语言中立不进 i18n 表，仅 tooltip 走 t()
const EXT_CHIPS = ['ts', 'md', 'json', 'go'] as const

const activeExt = computed(() =>
  EXT_CHIPS.find((e) => props.pattern === `*.${e}`) ?? '',
)

// 单选起步语义：点未亮 chip = 覆盖式预填；点已亮 chip = 清空回「不过滤」。
// 二阶段注记：多扩展组合（glob {*.a,*.b} 合并语法）待后续提案——需先核实
// Windows rg / Linux git grep 双后端的 brace 展开语义一致，否则跨平台结果漂移
function toggle(ext: string) {
  emit('update:pattern', activeExt.value === ext ? '' : `*.${ext}`)
}
</script>

<template>
  <span
    class="ps-ext-chips"
    role="group"
    :aria-label="t('projectSearch.extChips')"
    :title="t('projectSearch.extChips')"
  >
    <!-- Enter 接管：卡片级 keydown 会在有结果时把 Enter 解释为「打开活动匹配」
         并关面板，焦点在 chip 上时必须拦下改为本 chip 激活（prevent 掉浏览器
         默认点击后显式 toggle，语义与鼠标一致） -->
    <button
      v-for="e in EXT_CHIPS"
      :key="e"
      type="button"
      class="ps-ext-chip"
      :class="{ 'is-active': activeExt === e }"
      :data-testid="`ps-ext-chip-${e}`"
      :aria-pressed="activeExt === e"
      :title="activeExt === e
        ? t('projectSearch.extChipClear', { glob: `*.${e}` })
        : t('projectSearch.extChipApply', { glob: `*.${e}` })"
      @click="toggle(e)"
      @keydown.enter.prevent.stop="toggle(e)"
    >.{{ e }}</button>
  </span>
</template>
