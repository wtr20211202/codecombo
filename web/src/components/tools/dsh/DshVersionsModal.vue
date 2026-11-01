<script setup lang="ts">
import { NButton, NCheckbox, NModal, NTag } from 'naive-ui'
import { useI18n } from '../../../composables/useI18n'
import type { DshVersionsApi } from '../../../composables/useDshVersions'

/**
 * dsh 版本管理弹层（P-20261001-20 从 DshConsoleView 拆出的渲染层）：
 * 检查更新 / 选择新版本升级 / 回退（失败态醒目块 + P-20261010-2 常驻兜底行）/
 * 预发布分档开关 / changelog 渲染。
 * 状态与动作全部来自宿主传入的 useDshVersions 实例（ctrl），本组件零逻辑。
 */
const { t } = useI18n()

const props = defineProps<{ ctrl: DshVersionsApi }>()

// ctrl 为稳定的单例对象（宿主 setup 创建），解构出的 ref 在模板自动解包
const {
  showVersions, verLoading, currentVersion, latestVersion, newerVersions, selectedVersion,
  upState, upError, rollbackVersion, canRollback, rollingBack,
  showRollbackRow, showPrerelease, currentIsPrerelease, latestStableVersion,
  changelogEntries, changelogLoading, changelogExpanded,
  upgradeBadge, upgradeActionText,
  checkVersions, startUpgrade, doRollback, requestRollback,
  changelogOf, changelogBrief, renderChangelog, onChangelogClick, fmtVersionTime,
} = props.ctrl
</script>

<template>
  <n-modal
    v-model:show="showVersions"
    preset="card"
    :title="t('dshConsole.versionsTitle')"
    style="width: var(--modal-w-md); max-width: 94vw"
  >
    <div class="ver-current">
      <span>{{ t('dshConsole.currentVersion') }}</span>
      <n-tag
        size="small"
        :type="upgradeBadge ? 'warning' : 'success'"
      >
        {{ currentVersion || t('dshConsole.versionUnknown') }}
      </n-tag>
      <!-- 当前版本自身是预发布版：如实提示所在通道，不自动降级（用户自决） -->
      <n-tag
        v-if="currentIsPrerelease"
        size="small"
        type="warning"
        :bordered="false"
        data-test="dsh-prerelease-channel"
      >
        {{ t('dshConsole.prereleaseChannel') }}
      </n-tag>
      <n-button
        size="tiny"
        quaternary
        :loading="verLoading"
        @click="checkVersions"
      >
        {{ t('dshConsole.recheck') }}
      </n-button>
    </div>
    <!-- 常驻回退入口（P-20261010-2）：config 有回退点即呈现——升级流程成功但
         新版功能性损坏时也有逃生通道；失败态的醒目回退块保留，此行是静默兜底 -->
    <div
      v-if="showRollbackRow"
      class="ver-rollback-row"
      data-test="dsh-rollback-row"
    >
      <span>{{ t('dshConsole.rollbackPointLabel', { version: rollbackVersion }) }}</span>
      <n-button
        size="tiny"
        type="error"
        secondary
        :loading="rollingBack"
        data-test="dsh-rollback-btn"
        @click="requestRollback"
      >
        {{ t('dshConsole.rollbackThis') }}
      </n-button>
    </div>
    <div
      v-if="upError"
      class="ver-error"
    >
      {{ upError }}
    </div>
    <div
      v-if="upState === 'success'"
      class="ver-hint ok"
    >
      {{ t('dshConsole.upDone') }}
    </div>
    <div class="ver-list-head">
      <!-- 预发布分档（P-20261010-2）：默认只推荐稳定版；开关为会话态，主动打开才见 alpha -->
      <n-checkbox
        v-model:checked="showPrerelease"
        size="small"
        data-test="dsh-prerelease-toggle"
      >
        {{ t('dshConsole.showPrerelease') }}
      </n-checkbox>
    </div>
    <div class="ver-list">
      <div
        v-for="v in newerVersions"
        :key="v.version"
        class="ver-item"
        :class="{ active: selectedVersion === v.version }"
        @click="selectedVersion = v.version"
      >
        <span class="ver-v">v{{ v.version }}</span>
        <n-tag
          v-if="v.version === latestVersion"
          size="tiny"
          type="info"
        >
          {{ t('dshConsole.latestTag') }}
        </n-tag>
        <span
          class="ver-date"
          :title="fmtVersionTime(v.date).full"
        >{{ fmtVersionTime(v.date).short }}</span>
      </div>
      <div
        v-if="!verLoading && newerVersions.length === 0"
        class="ver-empty"
        data-test="dsh-ver-empty"
      >
        <template v-if="!currentVersion">
          {{ t('dshConsole.versionUnknownHint') }}
        </template>
        <template v-else-if="currentIsPrerelease">
          {{ latestStableVersion
            ? t('dshConsole.upToDatePrerelease', { stable: latestStableVersion })
            : t('dshConsole.upToDatePrereleaseOnly') }}
        </template>
        <template v-else>
          {{ t('dshConsole.upToDate') }}
        </template>
      </div>
    </div>
    <!-- 选中版本的变更说明：简要直接展示，点击展开完整 markdown -->
    <div
      v-if="selectedVersion && (changelogOf(selectedVersion) || changelogLoading)"
      class="ver-cl"
    >
      <div class="ver-cl-head">
        <span>{{ t('dshConsole.clTitle', { version: selectedVersion }) }}</span>
        <a
          v-if="changelogOf(selectedVersion)?.url"
          :href="changelogOf(selectedVersion)!.url"
          target="_blank"
          rel="noopener"
        >{{ t('dshConsole.clOpenPage') }}</a>
      </div>
      <div
        v-if="changelogLoading && !changelogEntries.length"
        class="ver-cl-brief"
      >
        {{ t('dshConsole.clLoading') }}
      </div>
      <template v-else-if="changelogOf(selectedVersion)">
        <div
          class="ver-cl-brief"
          :class="{ expanded: changelogExpanded }"
        >
          <div
            v-if="changelogExpanded"
            class="ver-cl-body"
            @click="onChangelogClick"
            v-html="renderChangelog(changelogOf(selectedVersion)!.body)"
          />
          <template v-else>{{ changelogBrief(changelogOf(selectedVersion)!.body) || t('dshConsole.clEmpty') }}</template>
        </div>
        <a
          v-if="changelogOf(selectedVersion)!.body"
          href="#"
          class="ver-cl-toggle"
          @click.prevent="changelogExpanded = !changelogExpanded"
        >{{ changelogExpanded ? t('dshConsole.clCollapse') : t('dshConsole.clExpand') }}</a>
      </template>
    </div>
    <div
      v-if="newerVersions.length > 0"
      class="ver-actions"
    >
      <n-button
        size="small"
        type="primary"
        :disabled="!selectedVersion || upState !== 'idle'"
        :loading="upState === 'preparing' || upState === 'installing' || upState === 'restarting'"
        @click="startUpgrade"
      >
        {{ upgradeActionText }}
      </n-button>
    </div>
    <div
      v-if="upState === 'failed' && canRollback"
      class="ver-rollback"
    >
      <span>{{ t('dshConsole.rollbackHint', { version: rollbackVersion }) }}</span>
      <n-button
        size="small"
        type="error"
        :loading="rollingBack"
        @click="doRollback"
      >
        {{ t('dshConsole.rollbackTo', { version: rollbackVersion }) }}
      </n-button>
    </div>
    <div class="ver-form-hint">
      {{ t('dshConsole.versionsHint') }}
    </div>
  </n-modal>
</template>

<style scoped>
/* 选中版本的 changelog 区 */
.ver-cl { margin-top: 10px; padding: 8px 10px; border: 1px solid var(--border-subtle); border-radius: 6px; background: var(--bg-panel); }
.ver-cl-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; }
.ver-cl-head a { font-size: 11px; font-weight: 400; color: var(--accent-blue); text-decoration: none; }
.ver-cl-head a:hover { text-decoration: underline; }
.ver-cl-brief { font-size: 11px; line-height: 1.6; color: var(--text-secondary); white-space: pre-wrap; word-break: break-word; max-height: 46px; overflow: hidden; }
.ver-cl-brief.expanded { max-height: 220px; overflow-y: auto; }
.ver-cl-toggle { font-size: 11px; color: var(--accent-blue); text-decoration: none; display: inline-block; margin-top: 4px; }

.ver-cl-body { font-size: 12px; line-height: 1.65; color: var(--text-secondary); }
.ver-cl-body :deep(h1), .ver-cl-body :deep(h2), .ver-cl-body :deep(h3), .ver-cl-body :deep(h4) {
  font-size: 12.5px; color: var(--text-primary); margin: 10px 0 4px; font-weight: 600;
}
.ver-cl-body :deep(ul), .ver-cl-body :deep(ol) { padding-left: 18px; margin: 4px 0; }
.ver-cl-body :deep(li) { margin: 2px 0; }
.ver-cl-body :deep(a) { color: var(--accent-blue); text-decoration: none; }
.ver-cl-body :deep(a:hover) { text-decoration: underline; }
.ver-cl-body :deep(code) { font-family: var(--font-mono); font-size: 11px; background: var(--bg-elevated); padding: 1px 4px; border-radius: 3px; }
.ver-cl-body :deep(hr) { border: none; border-top: 1px solid var(--border-subtle); margin: 8px 0; }

/* 版本管理面板 */
.ver-current { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; color: var(--text-secondary); }
/* 常驻回退行（P-20261010-2）：静默兜底——比失败态回退块（.ver-rollback）更轻的着色 */
.ver-rollback-row {
  margin: 0 0 8px;
  padding: 6px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border: 1px solid var(--border-subtle);
  border-left: 2px solid var(--accent-red);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.ver-list-head { display: flex; justify-content: flex-end; margin-bottom: 4px; }
.ver-list { display: flex; flex-direction: column; gap: 4px; max-height: 280px; overflow: auto; }
.ver-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--bg-border);
  border-radius: 6px;
  cursor: pointer;
}
.ver-item:hover { background: var(--bg-hover); }
.ver-item.active { border-color: var(--accent-blue); background: var(--bg-active); }
.ver-v { font-size: 12px; font-weight: 500; color: var(--text-primary); }
.ver-date { margin-left: auto; font-size: 11px; color: var(--text-dim); }
.ver-empty { padding: 14px 0; font-size: 12px; color: var(--text-dim); text-align: center; }
.ver-actions { margin-top: 10px; display: flex; justify-content: flex-end; }
.ver-rollback {
  margin-top: 10px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid color-mix(in srgb, var(--accent-red) 40%, transparent);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--accent-red) 6%, transparent);
}
.ver-error { margin: 6px 0; font-size: 12px; color: var(--accent-red); }
.ver-hint { margin: 6px 0; font-size: 12px; color: var(--accent-green); }
.ver-hint.ok { color: var(--accent-green); }
.ver-form-hint { margin-top: 10px; font-size: 11px; color: var(--text-dim); }
</style>
