<script setup lang="ts">
// 行级「已修改」标记 + 单行恢复默认（P-20261003-171，对标 VS Code 设置页修改蓝条 +
// 齿轮 Reset Setting）：modified=true 时在行尾渲染品牌色竖条（区别于出厂默认的
// 视觉标记，tooltip 说明）与恢复小钮；未修改时整组件不渲染——占据的是行尾自由
// 空间（margin-left:auto 推到右缘），出现/消失不挤压行内既有内容，无布局跳动。
// 恢复动作由宿主行提供（emit('restore')）：直写行即时落 store，暂存行只复位
// pending 值、仍走「保存」链落盘——isDirty 整体护栏语义不变。
// 默认值来源遵循 P-20261001-14 惯例（load 合并前 defaults：font.ts 的
// FONT_DEFAULTS/EDITOR_DEFAULTS 等），无 defaults 定义的行渐进跳过不挂本组件。
//
// 【为何是 span[role=button] 而非 <button>】设置行的外层 .setting-row 是 <label>，
// 浏览器会把 label 内点击的默认动作转发给「首个可标记后代」（button/input/select
// 等）。naive-ui Checkbox/ Switch 均无真实 <input>（div 假实现），本组件未出现时
// 该转发是 no-op；一旦行尾出现 <button>，已修改行的任意行内点击（含点复选框本体）
// 都会被转发成「点恢复钮」——改动的设置被静默复原。span 不属于可标记元素，转发
// 链自然失效，行点击恢复「点复选框/空白处切换」的既有语义；键盘可达性由
// tabindex + Enter/Space 处理补齐。
import { NIcon } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'

// restoreTitle：恢复钮 tooltip 覆盖（P-20261006-49 分区补全引入）。安全分区
// 恢复默认有方向性——部分项恢复=降低防护（关 TLS/回退弱校验）、部分=升高
// （锁定族默认开启），宿主按行语义传入方向性文案；缺省仍用通用「恢复默认」。
// 只改提示不做特殊拦截：设置本身可改，标记只管可见性（提案②裁决）。
defineProps<{ modified: boolean; restoreTitle?: string }>()
const emit = defineEmits<{ (e: 'restore'): void }>()
const { t } = useI18n()
</script>

<template>
  <span
    v-if="modified"
    class="smm"
    data-testid="settings-modified-mark"
  >
    <span
      class="smm-bar"
      :title="t('settings.modifiedFromDefault')"
    />
    <span
      class="smm-restore"
      role="button"
      tabindex="0"
      :title="restoreTitle || t('settings.resetRowToDefault')"
      :aria-label="restoreTitle || t('settings.resetRowToDefault')"
      data-testid="settings-restore-default"
      @click="emit('restore')"
      @keydown.enter.prevent="emit('restore')"
      @keydown.space.prevent="emit('restore')"
    >
      <n-icon :size="12">
        <RefreshOutline />
      </n-icon>
    </span>
  </span>
</template>

<style scoped>
.smm {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  flex-shrink: 0;
}
/* VS Code 修改蓝条同款语义：品牌色竖条（四主题自动适配，零硬编码色值） */
.smm-bar {
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--brand-accent);
}
.smm-restore {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
}
.smm-restore:hover,
.smm-restore:focus-visible {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.smm-restore:focus-visible {
  outline: 1px solid var(--brand-accent);
  outline-offset: 0;
}
</style>
