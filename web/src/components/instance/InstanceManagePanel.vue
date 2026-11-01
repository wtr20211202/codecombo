<script setup lang="ts">
// 实例管理侧边栏：卡片式列表（状态行 / 本机置顶 / 操作按钮），由「管理实例」入口打开
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { NIcon, useMessage } from 'naive-ui'
import { RefreshOutline, OpenOutline, CreateOutline, TrashOutline } from '@vicons/ionicons5'
import { useInstanceStore, type Instance } from '../../stores/instance'
import { useUpdateCheckStore } from '../../stores/updateCheck'
import { useNotificationStore } from '../../stores/notification'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { updateApi } from '../../api/client'
import { copyText } from '../../utils/clipboard'
import { getInstanceDotColor, getInstanceHost, getInstanceDisplayName } from './instanceStatus'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'add'): void
  (e: 'switch', id: string): void
  (e: 'edit', inst: Instance): void
}>()

const instanceStore = useInstanceStore()
const notificationStore = useNotificationStore()
const updateCheckStore = useUpdateCheckStore()
const message = useMessage()
const { t } = useI18n()

const refreshing = ref(false)
const checkingId = ref<string | null>(null)

// 本机所属中心是否有更新（健康探测版本做 semver 对比，store 静默检查维护）。
// 仅本机声明了上级时展示提示，用户自行决定是否点"从中心更新"
const centerUpdateAvailable = computed(() => {
  const c = updateCheckStore.center
  if (!c) return null
  const local = instanceStore.instances.find(i => i.isLocal)
  return local?.parentId ? c : null
})

// 手动刷新按钮：强制重拉列表 + 全量探测（绕过 store 的探测 TTL）
async function refresh() {
  refreshing.value = true
  try {
    await instanceStore.ensureInstancesFresh(true)
    // 探测带回最新版本后顺手复评中心更新可用性
    void updateCheckStore.checkCenter(true)
  } finally {
    refreshing.value = false
  }
}

// 面板挂载时兜底刷新——初始加载（App.vue）在锁定期间会 423 失败导致列表为空。
// 面板打开期间 30s 轻轮询：实例上下线时状态点自动跟随，不用手动刷新；
// 顺手复评「中心有更新」——从中心更新完成后高亮消隐不依赖单次回调成功
// （探测有 30s TTL，复评近乎零成本）
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void instanceStore.ensureInstancesFresh()
  pollTimer = setInterval(() => {
    void instanceStore.ensureInstancesFresh()
    void updateCheckStore.checkCenter(true)
  }, 30_000)
})
onBeforeUnmount(() => {
  if (pollTimer !== null) clearInterval(pollTimer)
})

// 点击实例地址复制到剪贴板（分享/粘贴到浏览器直达）
async function copyInstanceUrl(inst: Instance) {
  const url = inst.url || ''
  if (!url) return
  await copyText(url)
  message.success(t('instance.urlCopied'))
}

function statusText(inst: Instance): string {
  if (inst.status === 'online') return t('instance.statusOnline')
  if (inst.status === 'offline') return t('instance.statusOffline')
  if (inst.status === 'invalid') return t('instance.statusInvalid')
  return t('instance.statusUnknown')
}

// 单实例测试（结果反映到状态点）
async function testInstance(inst: Instance) {
  checkingId.value = inst.id
  try {
    const status = await instanceStore.checkInstance(inst.id)
    if (status === 'online') message.success(t('instance.testSuccess'))
    else if (status === 'invalid') message.error(t('instance.testNotApp'))
    else message.error(t('instance.testFailed'))
  } finally {
    checkingId.value = null
  }
}

async function removeInstance(inst: Instance) {
  const ok = await confirmDialog({
    type: 'warning',
    title: t('instance.removeTitle'),
    content: t('instance.removeConfirm', { name: inst.name }),
    confirmText: t('common.delete'),
    cancelText: t('common.cancel'),
  })
  if (!ok) return
  try {
    await instanceStore.removeInstance(inst.id)
    message.success(t('instance.removed'))
  } catch { /* 拦截器处理 */ }
}

function jumpToInstance(inst: Instance) {
  const url = inst.url || ''
  if (url) window.open(url, '_blank', 'noopener')
}

// 子实例从中心更新：需要 parent 实例信息
function getParentInstance(inst: Instance): Instance | undefined {
  if (!inst.parentId) return undefined
  return instanceStore.instances.find(i => i.id === inst.parentId)
}

// updatingFromCenter 覆盖整个"下载+换包"周期（后端在请求内同步下载，
// 慢链路可持续数分钟）——期间按钮禁用并显示"更新中"，给用户持续可见的反馈
const updatingFromCenter = ref(false)

// pollCenterUpdateResult 轮询换包结果（/api/updates/status 的 result 字段
// 来自换包子进程写的结果文件：success / failed / rolled_back）。
// 重启窗口期（旧进程退出 → 换包 → 新进程拉起）请求会失败，属预期，继续轮询；
// 2 分钟仍未出结果则放弃判定，提示用户去日志确认
function pollCenterUpdateResult(inst: Instance) {
  let attempts = 0
  const maxAttempts = 60
  // 重评「中心有更新」直到消隐：成功后本机已是中心版本，但重启窗口期 settings/
  // 实例探测请求可能短暂失败被静默吞掉——一次性重评会把陈旧高亮留到 6h 后的
  // 周期检查（页面必须手动刷新才变灰）。带重试：center 清空或达上限才停
  let recheckTries = 0
  const recheckCenter = async () => {
    recheckTries++
    await updateCheckStore.checkCenter(true)
    if (updateCheckStore.center && recheckTries < 10) setTimeout(recheckCenter, 3000)
  }
  const tick = async () => {
    attempts++
    try {
      const res: any = await updateApi.status({ silent: true })
      const payload = res?.data || res || {}
      const result = payload.result as string | undefined
      if (result === 'success') {
        message.success(t('update.success'))
        notificationStore.add({
          type: 'success',
          category: 'system',
          title: t('notification.event.updateCompleted'),
          body: inst.name,
        })
        // 新进程已就绪：立即重评「中心有更新」状态，提示行/按钮高亮随之消隐，
        // 不等下一次周期检查（默认 6h）
        void recheckCenter()
        return
      }
      if (result === 'failed' || result === 'rolled_back') {
        message.error(t('update.failed'))
        notificationStore.add({
          type: 'error',
          category: 'system',
          title: t('notification.event.updateFailed'),
          body: payload.resultError || inst.name,
        })
        // 回滚后版本未变，失败后版本未知——重评让提示与真实版本对齐
        void recheckCenter()
        return
      }
    } catch {
      // 重启窗口期（连接拒绝/断开）不判失败
    }
    if (attempts < maxAttempts) {
      setTimeout(tick, 2000)
    } else {
      notificationStore.add({
        type: 'warning',
        category: 'system',
        title: t('update.updateStarted'),
        body: inst.name,
      })
      // 放弃判定也重评一次：换包可能已成功只是结果文件超窗未读到
      void recheckCenter()
    }
  }
  setTimeout(tick, 3000)
}

async function updateFromCenter(inst: Instance) {
  if (updatingFromCenter.value) return
  const parent = getParentInstance(inst)
  if (!parent) {
    message.error(t('update.updateSourceNotConfigured'))
    return
  }
  updatingFromCenter.value = true
  try {
    // 清掉上次更新遗留的结果文件：轮询靠结果文件判定成败，不清会读到旧结论
    try { await updateApi.clearStatus() } catch { /* 无结果文件时忽略 */ }
    // 传上级实例 ID：中心地址与凭据由本机后端从存储解析（列表接口不出 token，
    // 浏览器侧永远读不到，曾导致中心锁定时拉取必 423）
    await updateApi.applyFromCenter(parent.id)
    message.success(t('update.updateStarted'))
    // 接入通知中心：系统更新已启动
    notificationStore.add({
      type: 'info',
      category: 'system',
      title: t('update.updateStarted'),
      body: inst.name,
    })
    // 轮询换包结果，成功/失败/回滚均有明确提示
    pollCenterUpdateResult(inst)
  } catch (e: any) {
    // 失败必须 toast（拦截器有 5s toast，但这类操作用户盯的就是按钮，
    // 双保险确保不被错过）+ 通知中心留档
    message.error(e?.userMessage || t('update.failed'))
    notificationStore.add({
      type: 'error',
      category: 'system',
      title: t('update.failed'),
      body: e?.userMessage,
    })
  } finally {
    updatingFromCenter.value = false
  }
}
</script>

<template>
  <div class="detail-panel">
    <div class="detail-header">
      <span class="detail-title">{{ t('instance.instances') }}</span>
      <div class="detail-header-actions">
        <button
          class="icon-btn"
          :title="t('instance.refreshStatus')"
          @click="refresh"
        >
          <n-icon
            size="13"
            :class="{ spinning: refreshing }"
          >
            <RefreshOutline />
          </n-icon>
        </button>
        <button
          class="icon-btn"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>
    </div>

    <div class="detail-list">
      <div
        v-for="inst in instanceStore.orderedInstances"
        :key="inst.id"
        class="detail-card"
        :class="{ active: inst.id === instanceStore.currentInstanceId }"
      >
        <div class="detail-card-header">
          <span
            class="detail-status-dot"
            :style="{ background: getInstanceDotColor(inst) }"
          />
          <span class="detail-name">{{ getInstanceDisplayName(inst) }}</span>
          <span
            v-if="inst.role === 'center'"
            class="detail-badge center"
          >{{ t('update.roleCenter') }}</span>
          <span
            v-else-if="inst.role === 'child'"
            class="detail-badge sub"
          >{{ t('update.roleSub') }}</span>
          <span
            v-if="inst.id === instanceStore.currentInstanceId"
            class="detail-current"
          >{{ t('instance.current') }}</span>
        </div>
        <div
          class="detail-url"
          :title="inst.url ? t('instance.copyUrl') : ''"
          @click="copyInstanceUrl(inst)"
        >
          {{ getInstanceHost(inst) }}
        </div>
        <div
          v-if="!inst.isLocal"
          class="detail-status"
          :style="{ color: getInstanceDotColor(inst) }"
        >
          {{ statusText(inst) }}<span
            v-if="inst.version"
            class="detail-version"
          > · v{{ inst.version }}</span>
        </div>
        <div
          v-if="inst.role === 'child' && getParentInstance(inst)"
          class="detail-parent"
        >
          {{ t('update.parentInstance') }}: {{ getParentInstance(inst)!.name }}
        </div>
        <div
          v-if="!inst.isLocal"
          class="detail-actions"
        >
          <button
            v-if="inst.id !== instanceStore.currentInstanceId"
            class="detail-action primary"
            @click="emit('switch', inst.id)"
          >
            {{ t('instance.switchTo') }}
          </button>
          <button
            class="detail-action"
            :disabled="checkingId === inst.id"
            @click="testInstance(inst)"
          >
            {{ checkingId === inst.id ? t('instance.testing') : t('instance.testConnection') }}
          </button>
          <button
            v-if="inst.role === 'child' && inst.id === instanceStore.currentInstanceId"
            class="detail-action"
            :disabled="updatingFromCenter"
            @click="updateFromCenter(inst)"
          >
            {{ updatingFromCenter ? t('update.updating') : t('update.updateFromCenter') }}
          </button>
          <button
            class="detail-action"
            :title="t('update.jumpToInstance')"
            @click="jumpToInstance(inst)"
          >
            <n-icon size="12">
              <OpenOutline />
            </n-icon>
          </button>
          <button
            class="detail-action"
            :title="t('instance.edit')"
            @click="emit('edit', inst)"
          >
            <n-icon size="12">
              <CreateOutline />
            </n-icon>
          </button>
          <button
            class="detail-action danger"
            :title="t('instance.remove')"
            @click="removeInstance(inst)"
          >
            <n-icon size="12">
              <TrashOutline />
            </n-icon>
          </button>
        </div>
        <!-- 本机：声明了上级时可从中心更新（本机自己拉取替换二进制）+ 可编辑 -->
        <div
          v-else
          class="detail-actions"
        >
          <div
            v-if="centerUpdateAvailable"
            class="detail-update-hint"
          >
            {{ t('update.centerHasUpdate') }} · v{{ centerUpdateAvailable.version }}
          </div>
          <button
            v-if="inst.role === 'child'"
            class="detail-action"
            :class="{ 'primary-attention': centerUpdateAvailable }"
            :title="centerUpdateAvailable
              ? t('update.centerHasUpdate') + ' · v' + centerUpdateAvailable.version
              : t('update.centerUpToDate')"
            :disabled="updatingFromCenter"
            @click="updateFromCenter(inst)"
          >
            {{ updatingFromCenter ? t('update.updating') : t('update.updateFromCenter') }}
          </button>
          <button
            class="detail-action"
            :title="t('instance.edit')"
            @click="emit('edit', inst)"
          >
            <n-icon size="12">
              <CreateOutline />
            </n-icon>
          </button>
        </div>
      </div>

      <!-- 空态：只有本机时提示 -->
      <div
        v-if="!instanceStore.instances.some(i => !i.isLocal)"
        class="detail-empty"
      >
        {{ t('instance.noRemote') }}
      </div>
    </div>

    <button
      class="detail-add-btn"
      @click="emit('add')"
    >
      + {{ t('instance.addRemote') }}
    </button>
  </div>
</template>

<style scoped>
.detail-panel {
  position: fixed; left: 48px; top: 0; bottom: 0; width: 280px;
  background: var(--bg-panel); border-right: 1px solid var(--border-default);
  z-index: 1500; display: flex; flex-direction: column;
  box-shadow: var(--shadow-pop-drawer-l);
}
.detail-header {
  padding: 10px 12px; display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid var(--border-subtle);
}
.detail-title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.detail-header-actions { display: flex; align-items: center; gap: 2px; }
.icon-btn {
  background: none; border: none; color: var(--text-secondary); cursor: pointer;
  font-size: 13px; padding: 3px 6px; border-radius: 3px; display: inline-flex; align-items: center;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
/* .spinning 旋转动画由 App.vue 全局提供 */

.detail-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.detail-card {
  padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border-subtle);
  background: var(--bg-primary); transition: border-color var(--motion-base);
}
.detail-card.active { border-color: var(--accent-blue); }
.detail-card-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.detail-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.detail-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.detail-current { font-size: 10px; padding: 0 4px; border-radius: 2px; background: var(--accent-blue); color: var(--text-on-accent); margin-left: auto; }
.detail-badge { font-size: 10px; padding: 0 4px; border-radius: 2px; margin-left: 4px; }
.detail-badge.center { background: var(--accent-green); color: var(--text-on-accent); }
.detail-badge.sub { background: var(--accent-blue); opacity: 0.7; color: var(--text-on-accent); }
.detail-url { font-size: 11px; color: var(--text-dim); margin-bottom: 4px; word-break: break-all; font-family: var(--font-mono); cursor: pointer; }
.detail-url:hover { color: var(--accent-blue); }
.detail-status { font-size: 11px; margin-bottom: 6px; }
.detail-version { color: var(--accent-green-dim); font-family: var(--font-mono); }
.detail-parent { font-size: 11px; color: var(--text-dim); margin-bottom: 4px; }
.detail-actions { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
/* 中心有新版本的提示行：占满一行把按钮挤到下一行，绿色引导注意 */
.detail-update-hint {
  flex-basis: 100%;
  font-size: 11px;
  color: var(--accent-green);
}
.detail-action.primary-attention {
  background: var(--accent-green); border-color: var(--accent-green); color: var(--bg-primary); font-weight: 600;
}
.detail-action.primary-attention:hover { opacity: 0.85; }
.detail-action {
  font-size: 11px; padding: 2px 8px; border-radius: 3px; cursor: pointer;
  background: var(--bg-hover); border: 1px solid var(--border-subtle); color: var(--text-secondary);
  display: inline-flex; align-items: center;
}
.detail-action:hover { background: var(--bg-active); color: var(--text-primary); }
.detail-action:disabled { opacity: 0.5; cursor: not-allowed; }
.detail-action.primary {
  background: var(--accent-blue); border-color: var(--accent-blue); color: var(--text-on-accent);
}
.detail-action.primary:hover { background: var(--accent-blue-hover); color: var(--text-on-accent); }
.detail-action.danger { color: var(--accent-red); }
.detail-action.danger:hover { background: var(--accent-red); color: var(--text-on-accent); border-color: var(--accent-red); }
.detail-empty {
  padding: 24px 12px; text-align: center; font-size: 12px; color: var(--text-dim);
  border: 1px dashed var(--border-default); border-radius: 6px;
}
.detail-add-btn {
  margin: 8px; padding: 8px; border-radius: 6px; border: 1px dashed var(--border-default);
  background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 13px;
}
.detail-add-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>
