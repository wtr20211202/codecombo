<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NModal, NForm, NFormItem, NInput, NProgress, NButton, NSelect, createDiscreteApi } from 'naive-ui'
import { cloneApi, CLONE_DEST_EXISTS_RE, CLONE_URL_INVALID_RE } from '../../api/client'
import { AppError } from '../../api/error-types'
import { isValidCloneUrl } from '../../utils/cloneUrl'
import { useCloneUrlHistory } from '../../composables/useCloneUrlHistory'
import { useThemeStore } from '../../stores/theme'
import { useI18n } from '../../composables/useI18n'
import { useCloneProgress, type CloneStatus, type CloneResult } from '../../composables/useCloneProgress'
import { useCloneBranchPrefetch } from '../../composables/useCloneBranchPrefetch'

const props = defineProps<{
  show: boolean
  /** 状态条点击重开（P-20261003-58）：附加显示指定任务的进度视图 */
  attachTaskId?: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  cloned: []
}>()

const themeStore = useThemeStore()
const { t } = useI18n()

const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({
    theme: themeStore.naiveTheme,
    themeOverrides: themeStore.naiveOverrides,
  })),
})

const modelShow = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
})

const cloneUrl = ref('')
const cloneDir = ref('')
const cloneBranch = ref('')

// 克隆 URL 历史写入点（P-20261003-251）：本弹窗只记录不展示——聚焦下拉回填
// 入口在新增项目弹窗克隆 tab（P-241 上次选择记忆同址）；两入口共用一份历史
const { recordUrl: recordCloneUrl } = useCloneUrlHistory()

// 克隆前分支预取（P-20261003-93）：「拉取分支」→ ls-remote → 分支下拉可选；
// 失败行内提示不阻断克隆（本弹窗无 SSH 密钥选择，直连默认钥匙语义）
const { branches: cloneBranches, branchOptions, loadingBranches, branchErrorKey, fetchBranches, resetBranches } = useCloneBranchPrefetch()

function handleFetchBranches() {
  fetchBranches(cloneUrl.value)
}

// URL 编辑即丢弃旧列表/旧提示——列表只对拉取时的 URL 成立
watch(cloneUrl, () => {
  resetBranches()
})

// 服务端目录预检（P-20261003-26）400：CLONE_DEST_EXISTS_RE（http.ts 导出，与
// KNOWN_ERROR_I18N 同源）命中即目标目录行内报错，不弹全局 toast
const dirError = ref('')

// URL 形态即时校验（P-20261003-70）：打字瞬间行内红提示（不阻断输入），提交前
// 拦下不发请求——失败时点从「任务启动跑一阵才失败」前移到输入时；规则收口
// utils/cloneUrl.ts（与服务端 precheckCloneURL 同规则，400 双保险兜底直达 API）。
// 空值不提示（必填告警由 cloneWarning 承担）
const urlError = computed(() =>
  cloneUrl.value && !isValidCloneUrl(cloneUrl.value) ? t('clone.urlInvalid.label') : '')

// 克隆进度：进度条/最近日志行实时跟随 WS；「取消」在克隆中为真取消
//（调 cancel API 终止任务）——此前仅关弹窗、任务后台跑完还弹「克隆成功」
const { status, lines, progress, taskId, connect, startClone, cancelClone } = useCloneProgress()
const cloneRunning = computed(() => status.value === 'running')
const cloneStarting = ref(false)
const lastLine = computed(() => lines.value[lines.value.length - 1] || '')

// 状态条点击重开：附加到指定任务的进度视图。CloneProgressWS 按 taskId 幂等
// 重连（快照补发无损）；taskId 相同（本实例自己的任务）则免重连直接复用
watch(() => [props.show, props.attachTaskId] as const, ([show, tid]) => {
  if (!show || !tid || tid === taskId.value) return
  connect(tid, onAttachDone)
})

// 附加观察的任务到达终态：成功/失败提示归启动方回调或孤儿兜底（tracker），
// 本回调绝不重复弹；这里只做项目列表刷新联动 + 复位出干净表单再关
function onAttachDone() {
  resetForm()
  emit('update:show', false)
  emit('cloned')
}

function resetForm() {
  cloneUrl.value = ''
  cloneDir.value = ''
  cloneBranch.value = ''
  resetBranches()
}

function onCloneDone(s: CloneStatus, r: CloneResult | null) {
  if (s === 'success') {
    message.success(t('layout.cloneSuccess'))
    resetForm()
    emit('update:show', false)
    emit('cloned')
  } else if (s === 'canceled') {
    message.info(t('layout.cloneCanceled'))
  } else {
    message.error(r?.error ? `${t('layout.cloneFail')}: ${r.error}` : t('layout.cloneFail'))
  }
}

async function handleClone() {
  if (cloneRunning.value) {
    await cancelClone()
    return
  }
  if (!cloneUrl.value || !cloneDir.value) {
    message.warning(t('layout.cloneWarning'))
    return
  }
  // URL 形态不合法：行内红提示已即现（urlError computed），不发请求
  if (urlError.value) return
  // 克隆 URL 历史（P-20261003-251）：提交即记录（与新增项目弹窗同口径）；含凭据
  // URL 由 recordUrl 内部跳过（明文密钥不落 localStorage）
  recordCloneUrl(cloneUrl.value)
  dirError.value = ''
  cloneStarting.value = true
  try {
    await startClone({
      url: cloneUrl.value,
      dir: cloneDir.value,
      branch: cloneBranch.value || undefined,
    }, onCloneDone, {
      // silent: 拦截器全局 toast 可能被 NModal 遮挡，改由 onCloneDone 用局部 message 弹
      // errorLabel: 错误标签记录友好标签（silent 不影响 errorLog.add）
      errorLabel: 'layout.cloneFail',
      silent: true,
    })
  } catch (e) {
    if (e instanceof AppError && CLONE_DEST_EXISTS_RE.test(e.rawMessage)) {
      // 预检命中：目标目录行内错误（失败时点前移到点击瞬间），改目录即清除
      dirError.value = t('clone.destExists.label')
    } else if (e instanceof AppError && CLONE_URL_INVALID_RE.test(e.rawMessage)) {
      // 双保险兜底：正常情况提交前已被 urlError 拦下不达请求；直达服务端规则
      // 漂移时仍给出与行内提示一致的友好文案
      message.error(t('clone.urlInvalid.label'))
    } else {
      message.error(t('layout.cloneFail'))
    }
  } finally {
    cloneStarting.value = false
  }
}
</script>

<template>
  <!-- 克隆中可关闭（P-20261003-58）：关闭=转后台，任务不受影响，首页状态条
       常驻展示进度；遮罩仍不可点关（防误触丢表单） -->
  <n-modal
    v-model:show="modelShow"
    preset="dialog"
    :title="t('layout.cloneTitle')"
    :mask-closable="false"
    @positive-click="handleClone"
  >
    <n-form>
      <n-form-item :label="t('layout.repoUrl')" :show-feedback="!urlError">
        <div class="clone-url-row">
          <n-input
            v-model:value="cloneUrl"
            :placeholder="t('layout.repoUrlPlaceholder')"
            :disabled="cloneRunning"
          />
          <!-- 拉取分支（P-20261003-93）：ls-remote 预取远端分支填充分支下拉；
               可选步骤，失败只行内提示不阻断克隆 -->
          <NButton
            size="small"
            :disabled="!cloneUrl.trim() || cloneRunning"
            :loading="loadingBranches"
            data-testid="clone-fetch-branches"
            @click="handleFetchBranches"
          >
            {{ t('clone.branches.fetch') }}
          </NButton>
        </div>
      </n-form-item>
      <div
        v-if="urlError"
        data-testid="clone-url-error"
        class="clone-url-error"
      >
        {{ urlError }}
      </div>
      <n-form-item :label="t('layout.targetDir')" :show-feedback="!dirError">
        <n-input
          v-model:value="cloneDir"
          :placeholder="t('layout.targetDirPlaceholder')"
          :disabled="cloneRunning"
          @update:value="dirError = ''"
        />
      </n-form-item>
      <div
        v-if="dirError"
        data-testid="clone-dir-error"
        class="clone-dir-error"
      >
        {{ dirError }}
      </div>
      <n-form-item :label="t('layout.branchOptional')" :show-feedback="!branchErrorKey">
        <!-- 预取到分支 → 可搜下拉（tag 保留手填任意分支能力）；否则维持手填输入框 -->
        <n-select
          v-if="cloneBranches.length"
          :value="cloneBranch || null"
          :options="branchOptions"
          filterable
          tag
          clearable
          :placeholder="t('layout.branchPlaceholder')"
          :disabled="cloneRunning"
          data-testid="clone-branch-select"
          @update:value="(v: string | null) => cloneBranch = v || ''"
        />
        <n-input
          v-else
          v-model:value="cloneBranch"
          :placeholder="t('layout.branchPlaceholder')"
          :disabled="cloneRunning"
        />
      </n-form-item>
      <div
        v-if="branchErrorKey"
        data-testid="clone-branch-error"
        class="clone-dir-error"
      >
        {{ t(branchErrorKey) }}
      </div>
    </n-form>

    <!-- 克隆中：进度条 + 最近一行输出（大仓库克隆分钟级，只转圈无从判断卡没卡） -->
    <div
      v-if="cloneRunning"
      class="clone-running"
    >
      <n-progress
        type="line"
        :percentage="progress"
        indicator-placement="inside"
        processing
      />
      <div
        class="clone-last-line"
        :title="lastLine"
      >{{ lastLine || t('layout.clonePreparing') }}</div>
    </div>

    <template #action>
      <div class="clone-actions">
        <template v-if="cloneRunning">
          <NButton
            size="small"
            type="warning"
            @click="handleClone"
          >
            {{ t('layout.cloneCancelBtn') }}
          </NButton>
        </template>
        <template v-else>
          <NButton
            size="small"
            quaternary
            @click="modelShow = false"
          >
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            size="small"
            type="primary"
            :loading="cloneStarting"
            @click="handleClone"
          >
            {{ t('layout.cloneBtn') }}
          </NButton>
        </template>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
/* URL 输入 + 拉取分支小钮同行（P-20261003-93）：预取是可选加速，小钮弱于主操作 */
.clone-url-row {
  display: flex;
  gap: 8px;
  width: 100%;
  align-items: center;
}
.clone-url-row > :first-child {
  flex: 1;
}

/* 表单行内错误（目录预检 P-20261003-26 / URL 形态预检 P-20261003-70；分支预取
   失败行内提示 P-20261003-93 复用 clone-dir-error）：
   show-feedback 折叠表单项反馈区后紧贴输入框 */
.clone-dir-error,
.clone-url-error {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--error-color, #d03050);
}

.clone-running {
  margin-top: 4px;
}

.clone-last-line {
  margin-top: 6px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clone-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
