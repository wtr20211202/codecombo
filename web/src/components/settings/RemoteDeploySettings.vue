<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  NCard, NButton, NInput, NSpace, NTag,
  NModal, NEmpty, NSpin, NAlert, NGrid, NGridItem, NIcon,
  NDropdown, NTooltip, NForm, NFormItem, useMessage,
} from 'naive-ui'
import {
  AddOutline, RefreshOutline, ServerOutline, TerminalOutline, EllipsisHorizontalOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { friendlyRemoteError } from '../../utils/remoteErrors'
import { useRemoteHostStore } from '../../stores/remoteHost'
import { useDeployConfigStore } from '../../stores/deployConfig'
import { useRemoteOpsStore } from '../../stores/remoteOps'
import { useHostStatus } from '../../composables/useHostStatus'
import { type TestConnectionResult, type RemoteHost, settingsApi } from '../../api/client'
import DeployDialog from '../deploy/DeployDialog.vue'
import PathInput from '../common/PathInput.vue'
import RemoteHostFormModal from '../remote/RemoteHostFormModal.vue'
import RemoteTunnelPanel from '../remote/RemoteTunnelPanel.vue'

// paneActive：本分区是否为设置弹窗当前页签（SettingsInstantPanes 下发）——
// 活跃隧道面板的低频轮询只在「弹窗开 + 停在本分区」时运行
const props = defineProps<{ show: boolean; paneActive?: boolean }>()
defineExpose({ load })

// 隧道观测面可见 = 弹窗开（show）且停在本分区（paneActive 缺省按可见兜底，
// 旧调用方不传时行为不回退）
const tunnelsActive = computed(() => props.show && (props.paneActive ?? true))

const { t } = useI18n()
const message = useMessage()
const router = useRouter()

const remoteHostStore = useRemoteHostStore()
const deployConfigStore = useDeployConfigStore()
// 诊断 / 远程执行 / AI 对话弹窗为 App 全局实例，部署弹窗参数也走 store（D4）
const remoteOps = useRemoteOpsStore()
// 主机在线状态（TCP 端口级探测，30s 共享轮询）
const { statusMap, refresh: refreshHostStatus } = useHostStatus()
const showDeployDialog = ref(false)

// 「更多」下拉：管理型操作收敛进菜单（B6：控制台 = 用、设置 = 管）
type MoreAction = 'diagnose' | 'exec' | 'deploy' | 'test' | 'edit' | 'delete'
const moreOptions = computed(() => [
  { label: t('remoteConsole.diagnoseHost'), key: 'diagnose' },
  { label: t('ai.remoteExec.button'), key: 'exec' },
  { label: t('deploy.host.deploy'), key: 'deploy' },
  { type: 'divider', key: 'd1' },
  { label: t('deploy.host.test'), key: 'test' },
  { label: t('common.edit'), key: 'edit' },
  { label: t('common.delete'), key: 'delete', props: { style: { color: 'var(--accent-red)' } } },
])

function onMoreSelect(host: { id: string; name: string }, key: MoreAction) {
  switch (key) {
    case 'diagnose': remoteOps.openDiagnose(host.id, host.name); break
    case 'exec': remoteOps.openExec(host.id, host.name); break
    case 'deploy': startDeploy(host.id); break
    case 'test': void testHost(host.id); break
    case 'edit': openEditHost(host); break
    case 'delete': hostPendingDelete.value = host; break
  }
}

// 删除确认（dropdown 内无法直接嵌 popconfirm，走确认弹窗）
const hostPendingDelete = ref<{ id: string; name: string } | null>(null)
const showDeleteConfirm = computed({
  get: () => !!hostPendingDelete.value,
  set: (v: boolean) => { if (!v) hostPendingDelete.value = null },
})
function confirmRemoveHost() {
  if (hostPendingDelete.value) void removeHost(hostPendingDelete.value.id)
}

/** 打开远程控制台并预选该主机（项目页内嵌视图，经 query 携参） */
function openConsole(hostId: string) {
  router.push({ path: '/project', query: hostId ? { view: 'remote', host: hostId } : { view: 'remote' } })
}

const showHostModal = ref(false)
// 编辑目标；null = 新建（表单逻辑在 RemoteHostFormModal 内）
const editingHost = ref<RemoteHost | null>(null)
const testing = ref(false)
const savingConfig = ref(false)

// 配置表单
const cfgToken = ref('')
const cfgBaseUrl = ref('')
const cfgModel = ref('')
const cfgBinaryDir = ref('')

async function load() {
  await Promise.all([
    remoteHostStore.fetch(),
    deployConfigStore.fetchConfig(),
    deployConfigStore.fetchDeployers(),
    deployConfigStore.fetchBinaries(),
    fetchPlatform(),
  ])
  syncConfigForm()
}

// 部署二进制名前缀：文案含 {os}-{arch} 模板（vue-i18n 插值），不传参会被
// 吞成 "--"（placeholder 渲染为「存放 codecombo-- 的目录」）——先以文档
// 示例值兜底，设置加载后换服务端真实平台（GOOS/GOARCH）
const binOs = ref('linux')
const binArch = ref('amd64')
const binParams = computed(() => ({ os: binOs.value, arch: binArch.value }))

async function fetchPlatform() {
  try {
    const res: any = await settingsApi.get()
    const [os, arch] = String(res?.data?.platform || '').split('/')
    if (os && arch) {
      binOs.value = os
      binArch.value = arch
    }
  } catch { /* 保持示例值 */ }
}

function syncConfigForm() {
  const c = deployConfigStore.config
  if (!c) return
  cfgToken.value = c.hasAnthropicToken ? '********' : ''
  cfgBaseUrl.value = c.anthropicBaseUrl || ''
  cfgModel.value = c.model || ''
  cfgBinaryDir.value = c.binaryDir || ''
}

function openCreateHost() {
  editingHost.value = null
  showHostModal.value = true
}

function openEditHost(host: any) {
  editingHost.value = host
  showHostModal.value = true
}

async function removeHost(id: string) {
  try {
    await remoteHostStore.remove(id)
    message.success(t('deploy.host.deleted'))
  } catch (e: any) {
    message.error(e?.userMessage || t('common.deleteFailed'))
  }
}

async function testHost(id: string) {
  testing.value = true
  try {
    const r: TestConnectionResult = await remoteHostStore.test(id) as any
    if (r.ok) {
      message.success(`${t('deploy.host.testOk')} (${r.whoami}@${r.os}/${r.arch})`)
    } else {
      message.error(`${t('deploy.host.testFail')}: ${friendlyRemoteError(r.error || '', t) || 'unknown'}`)
    }
  } finally {
    testing.value = false
    // 手动测试后后端会乐观刷新探测缓存，立即拉一次徽章状态
    void refreshHostStatus()
  }
}

async function saveConfig() {
  savingConfig.value = true
  try {
    await deployConfigStore.updateConfig({
      anthropicToken: cfgToken.value,
      anthropicBaseUrl: cfgBaseUrl.value,
      model: cfgModel.value,
      binaryDir: cfgBinaryDir.value,
    })
    await deployConfigStore.fetchBinaries()
    syncConfigForm()
    message.success(t('deploy.config.saved'))
  } catch (e: any) {
    message.error(e?.userMessage || t('common.saveFailed'))
  } finally {
    savingConfig.value = false
  }
}

async function rescanBinaries() {
  // 目录与 store 不一致时先保存，否则后端扫描会读到旧的 binaryDir
  const stored = deployConfigStore.config?.binaryDir || ''
  if (cfgBinaryDir.value && cfgBinaryDir.value !== stored) {
    try {
      await deployConfigStore.updateConfig({ binaryDir: cfgBinaryDir.value })
    } catch (e: any) {
      message.error(e?.userMessage || e?.message || t('deploy.config.saveFailed'))
      return
    }
  }
  try {
    await deployConfigStore.fetchBinaries()
    if (deployConfigStore.binaries.length === 0) {
      message.warning(t('deploy.config.noBinariesFound', binParams.value))
    } else {
      message.success(t('deploy.config.foundCount', { n: deployConfigStore.binaries.length }))
    }
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('deploy.config.scanFailed'))
  }
}

function startDeploy(hostId: string) {
  // D4：目标主机经 remoteOps store 传递（原 CustomEvent+setTimeout 有静默丢失窗口）
  remoteOps.openDeploy(hostId)
  showDeployDialog.value = true
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="remote-deploy-settings">
    <!-- 远程主机凭据 -->
    <n-card
      size="small"
      :title="t('deploy.host.section')"
      style="margin-bottom: 16px"
    >
      <template #header-extra>
        <n-button
          size="small"
          type="primary"
          @click="openCreateHost"
        >
          <template #icon>
            <n-icon :component="AddOutline" />
          </template>
          {{ t('deploy.host.add') }}
        </n-button>
      </template>

      <n-spin :show="remoteHostStore.loading">
        <n-empty
          v-if="remoteHostStore.hosts.length === 0"
          :description="t('deploy.host.empty')"
        />
        <n-space
          v-else
          vertical
          :size="8"
        >
          <div
            v-for="h in remoteHostStore.hosts"
            :key="h.id"
            class="host-row"
          >
            <div class="host-info">
              <n-icon
                :component="ServerOutline"
                size="18"
              />
              <div class="host-meta">
                <div class="host-name-line">
                  <span class="host-name">{{ h.name }}</span>
                  <n-tooltip
                    trigger="hover"
                    :disabled="!statusMap[h.id] || statusMap[h.id]!.state === 'unknown'"
                  >
                    <template #trigger>
                      <span
                        class="host-status"
                        :class="`is-${statusMap[h.id]?.state || 'unknown'}`"
                      />
                    </template>
                    {{ t('deploy.host.statusTooltip') }}
                  </n-tooltip>
                  <span
                    v-if="statusMap[h.id]?.state === 'online'"
                    class="host-latency"
                  >
                    {{ statusMap[h.id]!.latencyMs ?? 0 }}ms
                  </span>
                </div>
                <div class="host-detail">
                  {{ h.user }}@{{ h.host }}:{{ h.port }}
                </div>
              </div>
              <n-tag
                size="small"
                :type="h.authType === 'password' ? 'warning' : 'success'"
              >
                {{ t(`deploy.authType.${h.authType}`) }}
              </n-tag>
            </div>
            <div class="host-actions">
              <n-button
                size="small"
                type="primary"
                @click="openConsole(h.id)"
              >
                <template #icon>
                  <n-icon :component="TerminalOutline" />
                </template>
                {{ t('deploy.host.terminal') }}
              </n-button>
              <n-dropdown
                trigger="click"
                :options="moreOptions"
                @select="(key: string) => onMoreSelect(h, key as MoreAction)"
              >
                <n-button
                  size="small"
                  quaternary
                  :title="t('deploy.host.moreActions')"
                  :aria-label="t('deploy.host.moreActions')"
                >
                  <template #icon>
                    <n-icon :component="EllipsisHorizontalOutline" />
                  </template>
                </n-button>
              </n-dropdown>
            </div>
          </div>
        </n-space>
      </n-spin>

      <!-- 删除确认（下拉菜单触发） -->
      <n-modal
        v-model:show="showDeleteConfirm"
        preset="dialog"
        type="warning"
        :title="t('deploy.host.deleteTitle')"
        :positive-text="t('common.delete')"
        :negative-text="t('common.cancel')"
        :mask-closable="false"
        @positive-click="confirmRemoveHost"
      >
        {{ t('deploy.host.deleteConfirm', { name: hostPendingDelete?.name || '' }) }}
      </n-modal>
    </n-card>

    <!-- 活跃隧道行集（P-20261004-19）：远程穿透链路观测入口，低频轮询仅本分区可见时运行 -->
    <RemoteTunnelPanel :active="tunnelsActive" />

    <!-- 部署配置 -->
    <n-card
      size="small"
      :title="t('deploy.config.section')"
      style="margin-bottom: 16px"
    >
      <n-form
        label-placement="top"
        size="small"
      >
        <n-grid
          :cols="2"
          :x-gap="12"
        >
          <n-grid-item>
            <n-form-item :label="t('deploy.config.token')">
              <!-- autocomplete 必须走 input-props 才能落到内部原生 input——
                   直接写 attr 会挂在 .n-input 根 div 上无效，Chrome 会把页面唯一
                   的 password 框当登录框自动填充，白底无视主题 -->
              <n-input
                v-model:value="cfgToken"
                type="password"
                show-password-on="click"
                :input-props="{ autocomplete: 'new-password' }"
                :placeholder="t('deploy.config.tokenPlaceholder')"
              />
            </n-form-item>
          </n-grid-item>
          <n-grid-item>
            <n-form-item :label="t('deploy.config.baseUrl')">
              <n-input v-model:value="cfgBaseUrl" />
            </n-form-item>
          </n-grid-item>
          <n-grid-item :span="2">
            <n-form-item :label="t('deploy.config.model')">
              <n-input v-model:value="cfgModel" />
            </n-form-item>
          </n-grid-item>
          <n-grid-item :span="2">
            <n-form-item :label="t('deploy.config.binaryDir')">
              <PathInput
                v-model:value="cfgBinaryDir"
                :placeholder="t('deploy.config.binaryDirPlaceholder', binParams)"
              />
            </n-form-item>
          </n-grid-item>
        </n-grid>
      </n-form>

      <!-- 已发现的二进制 -->
      <div
        v-if="deployConfigStore.binaries.length > 0"
        class="binaries-list"
      >
        <div class="binaries-title">
          {{ t('deploy.config.foundBinaries') }}:
        </div>
        <n-space>
          <n-tag
            v-for="b in deployConfigStore.binaries"
            :key="b.fileName"
            size="small"
          >
            {{ b.os }}/{{ b.arch }} ({{ Math.round(b.sizeBytes / 1024 / 1024) }}MB)
          </n-tag>
        </n-space>
      </div>
      <n-alert
        v-else-if="cfgBinaryDir"
        type="warning"
        :show-icon="true"
        style="margin-top: 8px"
      >
        {{ t('deploy.config.noBinariesFound', binParams) }}
      </n-alert>

      <n-space
        justify="end"
        style="margin-top: 12px"
      >
        <n-button
          size="small"
          :loading="deployConfigStore.loading"
          @click="rescanBinaries"
        >
          <template #icon>
            <n-icon :component="RefreshOutline" />
          </template>
          {{ t('deploy.config.rescan') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :loading="savingConfig"
          @click="saveConfig"
        >
          {{ t('common.save') }}
        </n-button>
      </n-space>
    </n-card>

    <!-- 主机编辑弹窗（与远程控制台共用） -->
    <RemoteHostFormModal
      v-model:show="showHostModal"
      :host="editingHost"
      @saved="() => refreshHostStatus()"
    />

    <!-- 部署对话框 -->
    <DeployDialog v-model:show="showDeployDialog" />
  </div>
</template>

<style scoped>
.host-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 10px var(--space-3);
  background: var(--bg-panel);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
}
.host-info { display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 0; }
.host-meta { flex: 1; min-width: 0; }
.host-name-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.host-name { font-weight: var(--fw-medium); color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 在线徽章：online 绿 / offline 灰红 / unknown 灰（端口级探测，认证状态以实际连接为准） */
.host-status {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--text-dim);
}
.host-status.is-online { background: var(--accent-green); }
.host-status.is-offline { background: color-mix(in srgb, var(--accent-red) 55%, var(--text-dim)); }
.host-latency {
  font-size: var(--fs-meta-min, 11.5px); color: var(--text-muted); font-family: var(--font-mono);
  flex-shrink: 0;
}
/* user@host:port 防逐字换行：宽度不足时整体省略号，绝不词内断行 */
.host-detail {
  font-size: 12px; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.host-actions { display: flex; gap: 6px; flex-shrink: 0; }
.binaries-list { margin-top: var(--space-2); }
.binaries-title { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
</style>
