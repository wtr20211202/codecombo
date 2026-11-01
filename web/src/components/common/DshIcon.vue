<script setup lang="ts">
import BrandIcon from './BrandIcon.vue'

/**
 * dsh（DeepSeek Harness）品牌图标的 SFC 包装：
 * 活动栏/注册表以 `<component :is>` 渲染图标组件，函数式包装在 NIcon 插槽
 * 内会触发 Vue patch 异常（insertBefore），声明式 SFC 渲染路径稳定。
 */
</script>

<template>
  <BrandIcon
    name="dsh"
    :size="18"
  />
</template>
