<script setup lang="ts">
// 数据出域面总览卡（P-20261003-20）：设置·安全分区顶部的「安全姿态一页」——
// 只读聚合「这台实例的数据会流到哪里去」：webhook 外发端点（服务端已脱敏的
// host+路径）/ 活跃分享链接 / Agent Token 元信息 / 远程主机数量 + 安全事件审计
// 计数。本卡零写操作：每行「管理」直达既有管理面（设置内分区切换，或分享管理
// 主区视图——先经 exit 请宿主收起设置弹层再跳，?view=shares 由 useLayoutViews
// 消费，与部署分区的控制台直达同款 query 通道）。展示纪律与后端同源：URL 已在
// 服务端脱敏、token 不显值，这里不做二次加工也不请求任何明文口
import { ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { egressApi, type EgressOverview } from '../../api/client'
import { openSettingsTab } from '../../utils/openSettings'
import { formatDateTime } from '../../utils/git'

const props = defineProps<{ show: boolean }>()
// openTab 安全分区内部页签直达（agent token / 审计）；exit 跳主区视图前请宿主收起弹层
const emit = defineEmits<{
  (e: 'openTab', tab: 'agentToken' | 'audit'): void
  (e: 'exit'): void
}>()

const { t } = useI18n()
const router = useRouter()

const loading = ref(false)
const data = ref<EgressOverview | null>(null)

async function load() {
  loading.value = true
  try {
    data.value = await egressApi.overview()
  } catch {
    // 拦截器已弹错；总览面失败不留陈旧数据误导安全判断
    data.value = null
  } finally {
    loading.value = false
  }
}

// 设置弹层每次打开都重拉（show 常驻挂载语义与 SecuritySettings 容器一致）
onMounted(() => { if (props.show) void load() })
watch(() => props.show, (v) => { if (v) void load() })

// === 直达管理入口 ===
function goNotifications() {
  // webhook 偏好在「通知」分区（外发推送段）
  openSettingsTab('notifications')
}
function goDeploy() {
  // 远程主机凭据管理在「远程部署」分区（主机列表 + 表单）
  openSettingsTab('deploy')
}
function goShares() {
  // 分享管理是主区视图：收起设置弹层后经 query 通道进入（RemoteDeploySettings
  // 的控制台直达同款；useLayoutViews 消费 ?view=shares 并清理 query）
  emit('exit')
  void router.push({ path: '/project', query: { view: 'shares' } })
}

// === 行内展示 ===
const sharesVisibleMax = 8
const shareItems = ref<EgressOverview['shares']['items']>([])
function refreshShareItems() {
  shareItems.value = data.value?.shares.items.slice(0, sharesVisibleMax) ?? []
}
watch(data, refreshShareItems)

function shareTarget(s: EgressOverview['shares']['items'][number]): string {
  if (s.kind === 'snippet') return s.name
  // 无项目文件锚点的形态（直播/快照/回放 cast/回放 session）：以记录展示名
  // 标识——它们的 projectName/path 恒空，落到下面的拼接分支会显示空白
  //（cast 见 P-20261004-103；session 见 P-20261003-77）
  if (s.kind === 'terminal' || s.kind === 'terminal-frozen' || s.kind === 'cast' || s.kind === 'session') return s.name
  return s.path ? `${s.projectName}/${s.path}` : s.projectName
}
</script>

<template>
  <div
    class="egress-card"
    data-testid="egress-card"
  >
    <div class="egress-head">
      <div>
        <h4 class="egress-title">
          {{ t('settings.security.egress.title') }}
        </h4>
        <p class="egress-desc">
          {{ t('settings.security.egress.desc') }}
        </p>
      </div>
      <n-button
        size="tiny"
        quaternary
        :loading="loading"
        data-testid="egress-refresh"
        @click="load"
      >
        {{ t('common.refresh') }}
      </n-button>
    </div>

    <n-spin
      :show="loading"
      size="small"
    >
      <div class="egress-rows">
        <!-- webhook 外发端点（服务端脱敏展示态） -->
        <div
          class="egress-row"
          data-testid="egress-row-webhook"
        >
          <span class="egress-label">{{ t('settings.security.egress.webhook') }}</span>
          <span
            class="egress-value"
            data-testid="egress-webhook-endpoint"
          >
            <code
              v-if="data?.webhook.endpoint"
              class="egress-endpoint"
            >{{ data.webhook.endpoint }}</code>
            <template v-else>{{ t('settings.security.egress.webhookNone') }}</template>
            <span
              v-if="data?.webhook.endpoint && !data.webhook.enabled"
              class="egress-badge egress-badge-off"
            >{{ t('settings.security.egress.webhookOff') }}</span>
          </span>
          <n-button
            size="tiny"
            data-testid="egress-manage-webhook"
            @click="goNotifications"
          >
            {{ t('settings.security.egress.manage') }}
          </n-button>
        </div>

        <!-- 活跃分享链接（目标/创建/过期，与分享管理同源） -->
        <div
          class="egress-row"
          data-testid="egress-row-shares"
        >
          <span class="egress-label">{{ t('settings.security.egress.shares') }}</span>
          <span
            class="egress-value"
            data-testid="egress-shares-value"
          >
            <template v-if="data && data.shares.count > 0">
              {{ t('settings.security.egress.sharesCount', { n: data.shares.count }) }}
              <span
                v-for="s in shareItems"
                :key="s.kind + s.name + s.path + s.createdAt"
                class="egress-share-item"
              >
                <span class="egress-share-target">{{ shareTarget(s) }}</span>
                <span class="egress-share-created">{{ t('settings.security.egress.createdAt', { time: formatDateTime(s.createdAt) }) }}</span>
                <span
                  v-if="s.expiresAt"
                  class="egress-share-expiry"
                >{{ t('settings.security.egress.expiresAt', { time: formatDateTime(s.expiresAt) }) }}</span>
              </span>
              <span
                v-if="data.shares.count > shareItems.length"
                class="egress-share-more"
              >{{ t('settings.security.egress.sharesMore', { n: data.shares.count - shareItems.length }) }}</span>
            </template>
            <template v-else>{{ t('settings.security.egress.sharesNone') }}</template>
          </span>
          <n-button
            size="tiny"
            data-testid="egress-manage-shares"
            @click="goShares"
          >
            {{ t('settings.security.egress.manage') }}
          </n-button>
        </div>

        <!-- Agent Token：存在性与签发时间，不显值 -->
        <div
          class="egress-row"
          data-testid="egress-row-agent-token"
        >
          <span class="egress-label">{{ t('settings.security.egress.agentToken') }}</span>
          <span
            class="egress-value"
            data-testid="egress-agent-token-value"
          >
            <template v-if="data?.agentToken.exists">
              <code class="egress-endpoint">sca_{{ data.agentToken.prefix }}***</code>
              {{ t('settings.security.egress.issuedAt', { time: formatDateTime(data.agentToken.createdAt) }) }}
            </template>
            <template v-else>{{ t('settings.security.egress.agentTokenNone') }}</template>
          </span>
          <n-button
            size="tiny"
            data-testid="egress-manage-agent-token"
            @click="emit('openTab', 'agentToken')"
          >
            {{ t('settings.security.egress.manage') }}
          </n-button>
        </div>

        <!-- 远程主机：只出数量 -->
        <div
          class="egress-row"
          data-testid="egress-row-remote-hosts"
        >
          <span class="egress-label">{{ t('settings.security.egress.remoteHosts') }}</span>
          <span
            class="egress-value"
            data-testid="egress-remote-hosts-value"
          >
            {{ data ? t('settings.security.egress.hostsCount', { n: data.remoteHosts.count }) : '—' }}
          </span>
          <n-button
            size="tiny"
            data-testid="egress-manage-remote-hosts"
            @click="goDeploy"
          >
            {{ t('settings.security.egress.manage') }}
          </n-button>
        </div>

        <!-- 安全事件审计（修正项）：计数 + 查看面直达 -->
        <div
          class="egress-row"
          data-testid="egress-row-audit"
        >
          <span class="egress-label">{{ t('settings.security.egress.audit') }}</span>
          <span
            class="egress-value"
            data-testid="egress-audit-value"
          >
            {{ data ? t('settings.security.egress.auditCount', { n: data.audit.total }) : '—' }}
          </span>
          <n-button
            size="tiny"
            data-testid="egress-manage-audit"
            @click="emit('openTab', 'audit')"
          >
            {{ t('settings.security.egress.view') }}
          </n-button>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped src="./security-settings.css"></style>
