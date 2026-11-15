<script setup lang="ts">
// npm 安装形态提示（P-20261113-4-S1）：版本面板「发现新版本」块内主动告知——
// 本二进制经 npm 分发安装（服务端 IsNpmManaged 双通道判定，check 响应 npmManaged
// 旗标），node_modules 归 npm 管、应用内自更新必被 409 拒，更新请走包管理器。
// 宿主已把「立即更新」按钮替换为本块（旧服务端不携旗标时按钮保留、点更新由
// 409 反应式映射兜底）；新版本徽标/更新内容照常渲染。
// 命令一键复制复用面板 copyText 基建（utils/clipboard 降级链，copyCommitId 先例，
// 禁裸 navigator.clipboard——局域网 http 下为 undefined）。
// 自 VersionPanel 拆出：宿主已超单文件 500 行规范，新增块不再继续内联
//（UpdateCompanionWarning 同款拆件先例）
import { NIcon, useMessage } from 'naive-ui'
import { CopyOutline, InformationCircleOutline } from '@vicons/ionicons5'
import { copyText } from '../../utils/clipboard'
import { useI18n } from '../../composables/useI18n'

// npm 更新命令（P-20261113-2 定案 0.x 渠道口径：1.0 前 latest 恒跟随最新发布，
// 裸命令与 @latest 等价；尝鲜走 @next，不在本提示展开）。单点常量：文案与复制
// 同源，改口径只动这里
const NPM_UPDATE_CMD = 'npm i -g codecombo'

const message = useMessage()
const { t } = useI18n()

async function copyCommand() {
  if (await copyText(NPM_UPDATE_CMD)) {
    message.success(t('settings.copied'))
  } else {
    message.error(t('common.copyFailed'))
  }
}
</script>

<template>
  <div
    class="version-npm-hint"
    role="note"
    data-testid="version-npm-managed-hint"
  >
    <n-icon
      size="16"
      class="version-npm-hint-icon"
    >
      <InformationCircleOutline />
    </n-icon>
    <div class="version-npm-hint-body">
      <span class="version-npm-hint-text">{{ t('update.npmManagedHint') }}</span>
      <!-- 命令 chip 即复制钮（.version-commit 复制 commit id 同款交互：点 chip
           复制 + 成功/失败 toast）。带文本子节点非 icon-only，title 只是悬停补提示 -->
      <button
        class="version-npm-cmd"
        data-testid="version-npm-copy"
        type="button"
        :title="t('common.copy')"
        @click="copyCommand"
      >
        <code>{{ NPM_UPDATE_CMD }}</code>
        <n-icon
          size="13"
          class="version-npm-cmd-icon"
        >
          <CopyOutline />
        </n-icon>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 信息色走 --accent-blue（info 惯例，非告警黄——npm 形态是正常态不是故障），
   文字走正文色守对比度（均为语义名，色彩红线零硬编码） */
.version-npm-hint {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 10px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--accent-blue) 45%, transparent);
  background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
}
.version-npm-hint-icon { color: var(--accent-blue); flex-shrink: 0; margin-top: 1px; }
.version-npm-hint-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.version-npm-hint-text { color: var(--text-primary); font-size: 12.5px; line-height: 1.5; }
/* 命令 chip：mono 字体 + 描边（.version-commit 同设计语言），整块可点热区 */
.version-npm-cmd {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 8px; border: 1px solid color-mix(in srgb, var(--accent-blue) 45%, transparent);
  border-radius: 4px; background: var(--bg-primary);
  font-family: var(--font-mono, monospace); font-size: 12px;
  color: var(--accent-blue); cursor: pointer;
  transition: background var(--motion-base);
}
.version-npm-cmd:hover { background: color-mix(in srgb, var(--accent-blue) 16%, transparent); }
.version-npm-cmd code { font-family: inherit; }
.version-npm-cmd-icon { flex-shrink: 0; }
</style>
