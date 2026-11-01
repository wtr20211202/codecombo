<script setup lang="ts">
/**
 * 品牌图标（官方标，保持原彩色——一眼识别优先，参考 VS Code 扩展图标惯例）。
 * SVG 资产在 web/src/assets/brands/（Simple Icons 官方品牌标路径数据，本地打包、
 * 无运行时请求）；经 Vite ?raw 内联渲染，保留原始 fill 品牌色。
 * 新增品牌 = assets/brands/ 放官方 SVG + BRANDS 登记一行。
 */
import { computed } from 'vue'
import claudeSvg from '../../assets/brands/claude.svg?raw'
import dshSvg from '../../assets/brands/dsh.svg?raw'
import customSvg from '../../assets/brands/custom.svg?raw'

/** 品牌标识 → 官方 SVG 原文（含品牌色 fill 与 aria 标题）；custom 为通用兜底图形
 *（终端形状，currentColor 跟随文字色）——用户自定义智能体运行时与暂未登记
 * 官方标的运行时（如 codex）共用，不再误用 claude 标 */
const BRANDS: Record<string, string> = {
  claude: claudeSvg,
  dsh: dshSvg,
  custom: customSvg,
}

const props = withDefaults(
  defineProps<{
    /** 品牌标识：claude | dsh | custom（BRANDS 注册表 key，未知 key 回退通用图形并告警） */
    name: string
    /** 渲染尺寸（正方形边长 px） */
    size?: number
  }>(),
  { size: 16 },
)

const svg = computed(() => {
  const raw = BRANDS[props.name]
  if (!raw) {
    console.warn(`[BrandIcon] unknown brand: ${props.name}`)
    return customSvg
  }
  return raw
})

// 原始 SVG 无宽高属性（只有 viewBox），由组件按 size 注入尺寸；
// trusted input：静态打包资产，非用户数据，v-html 安全
const sizedSvg = computed(() =>
  svg.value.replace('<svg ', `<svg width="${props.size}" height="${props.size}" `),
)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html：内容为本地打包的官方 SVG 资产 -->
  <span
    class="brand-icon"
    style="display: inline-flex; flex-shrink: 0"
    v-html="sizedSvg"
  />
</template>
