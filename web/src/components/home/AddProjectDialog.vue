<script setup lang="ts">
import { watch } from 'vue'
import { NModal, NTabs, NTabPane, NInput, NInputNumber, NButton, NProgress, NSelect } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useAddProjectDialog } from '../../composables/useAddProjectDialog'
import PathInput from '../common/PathInput.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  'update:show': [v: boolean]
  added: []
}>()

const { t } = useI18n()
const dialog = useAddProjectDialog(() => emit('added'))

watch(() => props.show, (v) => {
  if (v && !dialog.show.value) dialog.openAddModal()
  else if (!v && dialog.show.value) dialog.show.value = false
}, { immediate: true })

watch(dialog.show, (v) => {
  if (v !== props.show) emit('update:show', v)
})
</script>

<template>
  <n-modal
    :show="dialog.show.value"
    preset="dialog"
    :title="t('home.addTitle')"
    :positive-text="dialog.addPositiveText.value"
    :negative-text="t('common.cancel')"
    :positive-button-props="dialog.positiveButtonProps.value"
    :mask-closable="false"
    style="width: var(--modal-w-md); max-width: 94vw"
    @update:show="(v: boolean) => dialog.show.value = v"
    @positive-click="dialog.handleAddPositiveClick"
  >
    <n-tabs
      v-model:value="dialog.addMode.value"
      type="line"
      size="small"
      style="margin-top: 4px"
    >
      <n-tab-pane
        name="local"
        :tab="t('home.clone.tabLocal')"
      >
        <div style="display: flex; flex-direction: column; gap: 12px; padding-top: 8px">
          <div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 6px">
              {{ t('home.projectPath') }}
            </div>
            <PathInput
              v-model:value="dialog.newProjectPath.value"
              :placeholder="t('home.pathPlaceholder')"
              @paste="dialog.onLocalPaste($event, 'path')"
              @enter="dialog.handleAddPositiveClick"
            />
            <!-- 克隆建议（P-20261003-170）：本地 tab 粘贴到远程 URL 形态 → 行内
                 建议一键切克隆并预填，可忽略不强制；LocaleSuggestBar 同族
                 （建议而非警示：中性底 + accent 蓝主动作） -->
            <div
              v-if="dialog.cloneSuggestVisible.value"
              data-testid="clone-suggest"
              class="clone-suggest-bar"
              role="status"
            >
              <span class="clone-suggest-text">{{ t('home.cloneSuggest.tip') }}</span>
              <span class="clone-suggest-spacer" />
              <n-button
                size="tiny"
                type="primary"
                secondary
                data-testid="clone-suggest-switch"
                @click="dialog.acceptCloneSuggest()"
              >
                {{ t('home.cloneSuggest.switch') }}
              </n-button>
              <n-button
                size="tiny"
                quaternary
                data-testid="clone-suggest-dismiss"
                :aria-label="t('home.cloneSuggest.dismiss')"
                @click="dialog.dismissCloneSuggest()"
              >
                {{ t('home.cloneSuggest.dismiss') }}
              </n-button>
            </div>
          </div>

          <div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 6px">
              {{ t('home.projectName') }}
            </div>
            <n-input
              v-model:value="dialog.newProjectName.value"
              :placeholder="t('home.namePlaceholder')"
              @paste="dialog.onLocalPaste($event, 'name')"
              @update:value="(v: string) => { dialog.nameManuallyEdited.value = !!v }"
            />
          </div>
        </div>
      </n-tab-pane>

      <n-tab-pane
        name="clone"
        :tab="t('home.clone.tabClone')"
      >
        <div
          v-if="dialog.cloneStatus.value === 'running'"
          style="display: flex; flex-direction: column; gap: 12px; padding-top: 8px"
        >
          <n-progress
            type="line"
            :percentage="dialog.cloneProgress.value"
            :height="10"
            status="info"
          />
          <div class="clone-log-area">
            <div
              v-for="(line, i) in dialog.cloneLines.value"
              :key="i"
              class="clone-log-line"
            >
              {{ line }}
            </div>
          </div>
          <div style="display: flex; justify-content: center">
            <n-button
              size="small"
              type="warning"
              @click="dialog.handleCancelClone"
            >
              {{ t('common.cancel') }}
            </n-button>
          </div>
        </div>
        <div
          v-else
          style="display: flex; flex-direction: column; gap: 12px; padding-top: 8px"
        >
          <div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 6px">
              {{ t('home.clone.repoUrl') }}
            </div>
            <div class="clone-url-row">
              <n-input
                v-model:value="dialog.cloneUrl.value"
                :placeholder="t('home.clone.repoUrlPlaceholder')"
                data-testid="clone-url-input"
                @blur="dialog.onCloneUrlBlur"
                @focus="dialog.onCloneUrlFocus"
                @click="dialog.onCloneUrlFocus"
                @keyup.enter="dialog.handleAddPositiveClick"
              />
              <!-- 克隆 URL 历史下拉（P-20261003-251）：聚焦出最近克隆 URL，前缀过滤，
                   点选回填；mousedown.prevent 保输入框焦点（点击不先触发 blur）——
                   ProjectSearch 查询历史同族 -->
              <div
                v-if="dialog.urlHistoryVisible.value"
                class="clone-url-history"
                data-testid="clone-url-history"
                @mousedown.prevent
              >
                <div
                  v-if="dialog.urlHistoryAllFilteredOut.value"
                  class="clone-url-history-empty"
                  data-testid="clone-url-history-empty"
                >
                  {{ t('home.clone.history.empty') }}
                </div>
                <div
                  v-else
                  class="clone-url-history-list"
                >
                  <button
                    v-for="(h, hi) in dialog.urlHistoryItems.value"
                    :key="h"
                    class="clone-url-history-item"
                    :data-testid="`clone-url-history-item-${hi}`"
                    :title="h"
                    @click="dialog.applyUrlHistory(h)"
                  >
                    <span class="clone-url-history-text">{{ h }}</span>
                  </button>
                </div>
                <button
                  class="clone-url-history-clear"
                  data-testid="clone-url-history-clear"
                  @click="dialog.onClearUrlHistory()"
                >
                  {{ t('home.clone.history.clear') }}
                </button>
              </div>
              <!-- 拉取分支（P-20261003-93）：ls-remote 预取远端分支填充分支下拉；
                   可选步骤，失败只行内提示不阻断克隆 -->
              <n-button
                size="small"
                :disabled="!dialog.cloneUrl.value.trim()"
                :loading="dialog.loadingBranches.value"
                data-testid="clone-fetch-branches"
                @click="dialog.fetchCloneBranches()"
              >
                {{ t('clone.branches.fetch') }}
              </n-button>
            </div>
            <!-- URL 形态即时校验（P-20261003-70）：打字瞬间行内红提示，与 CloneModal 同源 -->
            <div
              v-if="dialog.cloneUrlInvalid.value"
              data-testid="clone-url-error"
              class="clone-url-error"
            >
              {{ t('clone.urlInvalid.label') }}
            </div>
            <!-- 分支预取失败行内提示（P-20261003-93）：不阻断克隆（分支仍可手填） -->
            <div
              v-if="dialog.branchErrorKey.value"
              class="clone-branch-error"
              data-testid="clone-branch-error"
            >
              {{ t(dialog.branchErrorKey.value) }}
            </div>
            <div
              v-if="dialog.cloneMissingCredHost.value"
              class="clone-cred-tip"
            >
              <span>{{ t('home.clone.credMissing', { host: dialog.cloneMissingCredHost.value }) }}</span>
            </div>
            <div
              v-if="dialog.cloneSshKeys.value.length > 0"
              style="margin-top: 6px"
            >
              <n-select
                v-model:value="dialog.cloneSelectedSshKey.value"
                size="small"
                data-testid="clone-ssh-key-select"
                :placeholder="t('home.clone.sshKeyPlaceholder')"
                :options="dialog.sshKeyOptions.value"
                clearable
              />
            </div>
            <div
              v-else-if="dialog.isSshUrl.value"
              class="clone-cred-tip clone-key-mgr"
            >
              <span>{{ t('home.clone.sshKeyMissing') }}</span>
              <div class="clone-key-actions">
                <n-button
                  size="tiny"
                  :loading="dialog.sshKeyGenerating.value"
                  @click="dialog.generateCloneKey()"
                >
                  {{ t('home.clone.sshKeyGenerate') }}
                </n-button>
                <n-button
                  size="tiny"
                  @click="dialog.sshKeyImporting.value = !dialog.sshKeyImporting.value"
                >
                  {{ t('home.clone.sshKeyImport') }}
                </n-button>
              </div>
              <textarea
                v-if="dialog.sshKeyImporting.value"
                v-model="dialog.sshKeyImportPem.value"
                class="clone-import-pem"
                :placeholder="t('home.clone.sshKeyImportPlaceholder')"
                rows="5"
              />
              <n-button
                v-if="dialog.sshKeyImporting.value"
                size="tiny"
                type="primary"
                :disabled="!dialog.sshKeyImportPem.value.trim()"
                :loading="dialog.sshKeyGenerating.value"
                @click="dialog.importCloneKey()"
              >
                {{ t('home.clone.sshKeyImportConfirm') }}
              </n-button>
              <div
                v-if="dialog.sshKeyPubView.value"
                class="clone-pub-view"
              >
                <div class="clone-pub-title">
                  {{ t('home.clone.sshKeyPubTitle') }}
                </div>
                <code class="clone-pub-text">{{ dialog.sshKeyPubView.value }}</code>
                <n-button
                  size="tiny"
                  @click="dialog.copyClonePub()"
                >
                  {{ t('home.clone.sshKeyCopy') }}
                </n-button>
              </div>
            </div>
          </div>

          <div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 6px">
              {{ t('home.clone.targetDir') }}
            </div>
            <PathInput
              v-model:value="dialog.cloneDir.value"
              :placeholder="t('home.clone.targetDirPlaceholder')"
              @select="dialog.markCloneDirSelect"
            />
          </div>

          <div style="display: flex; gap: 12px">
            <div style="flex: 1">
              <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 6px">
                {{ t('home.clone.branchOptional') }}
              </div>
              <!-- 预取到分支 → 可搜下拉（tag 保留手填任意分支能力）；否则维持手填输入框 -->
              <n-select
                v-if="dialog.cloneBranches.value.length"
                :value="dialog.cloneBranch.value || null"
                :options="dialog.branchOptions.value"
                filterable
                tag
                clearable
                :placeholder="t('home.clone.branchPlaceholder')"
                data-testid="clone-branch-select"
                @update:value="(v: string | null) => dialog.cloneBranch.value = v || ''"
              />
              <n-input
                v-else
                v-model:value="dialog.cloneBranch.value"
                :placeholder="t('home.clone.branchPlaceholder')"
              />
            </div>
            <div style="width: 150px">
              <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 6px">
                {{ t('home.clone.depthOptional') }}
              </div>
              <n-input-number
                v-model:value="dialog.cloneDepth.value"
                :min="0"
                data-testid="clone-depth-input"
                style="width: 100%"
              />
            </div>
          </div>

          <div>
            <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 6px">
              {{ t('home.projectName') }}
            </div>
            <n-input
              v-model:value="dialog.cloneName.value"
              :placeholder="t('home.namePlaceholder')"
              @update:value="(v: string) => { dialog.cloneNameManuallyEdited.value = !!v }"
            />
          </div>
        </div>
      </n-tab-pane>
    </n-tabs>
  </n-modal>
</template>

<style scoped>
/* URL 输入 + 拉取分支小钮同行（P-20261003-93）：预取是可选加速，小钮弱于主操作；
   行容器 relative 兼作 URL 历史下拉（P-20261003-251）的锚定容器 */
.clone-url-row {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: center;
}
.clone-url-row > :first-child {
  flex: 1;
}
/* URL 形态行内错误（P-20261003-70）与分支预取行内错误（P-20261003-93）：
   红色弱化排版，与 CloneModal 同族 */
.clone-url-error,
.clone-branch-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--error-color, #d03050);
}

/* 克隆 URL 历史下拉（P-20261003-251）：锚定 URL 输入行下缘，遮住下方字段
   （ProjectSearch ps-history 同族——absolute 于 relative 行容器） */

.clone-url-history {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.clone-url-history-list {
  max-height: 220px;
  overflow-y: auto;
}

.clone-url-history-empty {
  padding: 16px 12px;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
}

.clone-url-history-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast);
}

.clone-url-history-item:hover {
  background: var(--bg-hover);
}

.clone-url-history-text {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clone-url-history-clear {
  padding: 6px 10px;
  border: none;
  border-top: 1px solid var(--border-subtle);
  background: transparent;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--motion-fast), color var(--motion-fast);
}

.clone-url-history-clear:hover {
  background: var(--bg-hover);
  color: var(--accent-red);
}

/* 克隆建议条（P-20261003-170）：建议而非警示——中性面板底 + accent 蓝主动作
   （LocaleSuggestBar 同族色系），零硬编码色值走主题变量 */
.clone-suggest-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 6px;
}

.clone-suggest-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 左侧提示与右侧动作弹性撑开：窄弹窗时优先保动作按钮完整可见 */
.clone-suggest-spacer {
  flex: 1;
}

.clone-cred-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--accent-yellow);
  background: var(--bg-warning-alt);
  border: 1px solid var(--accent-yellow);
  border-radius: 6px;
}
.clone-key-mgr {
  flex-wrap: wrap;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border-color: var(--border-default);
}
.clone-key-actions { display: flex; gap: 6px; }
.clone-import-pem {
  width: 100%;
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 6px 8px;
  background: var(--bg-panel);
  color: var(--text-body);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  resize: vertical;
}
.clone-pub-view { width: 100%; display: flex; flex-direction: column; gap: 4px; }
.clone-pub-title { font-size: 11px; color: var(--text-muted); }
.clone-pub-text {
  font-family: var(--font-mono);
  font-size: 11px;
  word-break: break-all;
  color: var(--text-body);
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 4px 6px;
}
.clone-log-area {
  max-height: 200px;
  overflow-y: auto;
  padding: 8px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
}
.clone-log-line {
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
