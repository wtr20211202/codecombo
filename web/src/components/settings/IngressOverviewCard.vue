<script setup lang="ts">
// 入口面总览卡（P-20261004-11）：设置·安全分区「安全姿态一页」的另一半——
// 只读聚合「谁在进来」：系统锁定与解锁失败计数 / Agent Token 配置态与最近轮换 /
// TLS 与明文回环辅助端口 / 活跃分享入口 / 远程主机数量。与出域总览卡
// （EgressOverviewCard，P-20261003-20）并列同形态：零写操作，每行「管理」直达
// 既有管理面（设置内页签切换，或分享管理主区视图——先经 exit 请宿主收起设置
// 弹层再跳，?view=shares 由 useLayoutViews 消费）。展示纪律与后端同源：失败
// 计数是服务端限流器的内存态聚合（无 IP 明细，重启清零——注记随行展示）、
// agent token 只显前缀掩码、TLS 只显开关与端口，这里不做二次加工也不请求
// 任何明文口
import { ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NSpin } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { ingressApi, type IngressOverview } from '../../api/client'
import { openSettingsTab } from '../../utils/openSettings'
import { formatDateTime } from '../../utils/git'

const props = defineProps<{ show: boolean }>()
// openTab 安全分区内部页签直达（锁定/TLS/agent token）；exit 跳主区视图
// 前请宿主收起弹层
const emit = defineEmits<{
  (e: 'openTab', tab: 'lock' | 'tls' | 'agentToken'): void
  (e: 'exit'): void
}>()

const { t } = useI18n()
const router = useRouter()

const loading = ref(false)
const data = ref<IngressOverview | null>(null)

async function load() {
  loading.value = true
  try {
    data.value = await ingressApi.overview()
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
function goDeploy() {
  // 远程主机凭据管理在「远程部署」分区（主机列表 + 表单）
  openSettingsTab('deploy')
}
function goShares() {
  // 分享管理是主区视图：收起设置弹层后经 query 通道进入（出域卡同款；
  // useLayoutViews 消费 ?view=shares 并清理 query）
  emit('exit')
  void router.push({ path: '/project', query: { view: 'shares' } })
}

// === 行内展示 ===
// 轮换时点：从未轮换时 rotatedAt 与 createdAt 同源同值，仅在确实轮换过时展示
function tokenRotated(d: IngressOverview): boolean {
  const m = d.agentToken
  return !!m.rotatedAt && m.rotatedAt !== m.createdAt
}
</script>

<template>
  <div
    class="ingress-card"
    data-testid="ingress-card"
  >
    <div class="ingress-head">
      <div>
        <h4 class="ingress-title">
          {{ t('settings.security.ingress.title') }}
        </h4>
        <p class="ingress-desc">
          {{ t('settings.security.ingress.desc') }}
        </p>
      </div>
      <n-button
        size="tiny"
        quaternary
        :loading="loading"
        data-testid="ingress-refresh"
        @click="load"
      >
        {{ t('common.refresh') }}
      </n-button>
    </div>

    <n-spin
      :show="loading"
      size="small"
    >
      <div class="ingress-rows">
        <!-- 系统锁定：开关态 + 解锁失败聚合计数（限流内存态，重启清零随行注记） -->
        <div
          class="ingress-row"
          data-testid="ingress-row-lock"
        >
          <span class="ingress-label">{{ t('settings.security.ingress.lock') }}</span>
          <span
            class="ingress-value"
            data-testid="ingress-lock-value"
          >
            <template v-if="data">
              <template v-if="data.lock.needsSetup">{{ t('settings.security.ingress.lockSetup') }}</template>
              <template v-else-if="data.lock.enabled">{{ t('settings.security.ingress.lockOn') }}</template>
              <template v-else>{{ t('settings.security.ingress.lockOff') }}</template>
              <span
                class="ingress-failures"
                data-testid="ingress-failures-value"
              >
                <template v-if="data.lock.failures.total > 0">
                  {{ t('settings.security.ingress.failures', {
                    total: data.lock.failures.total,
                    ips: data.lock.failures.ips,
                    blocked: data.lock.failures.blocked,
                  }) }}
                </template>
                <template v-else>{{ t('settings.security.ingress.failuresNone') }}</template>
              </span>
              <span class="ingress-note">{{ t('settings.security.ingress.failuresNote') }}</span>
            </template>
            <template v-else>—</template>
          </span>
          <n-button
            size="tiny"
            data-testid="ingress-manage-lock"
            @click="emit('openTab', 'lock')"
          >
            {{ t('settings.security.ingress.manage') }}
          </n-button>
        </div>

        <!-- Agent Token：存在性 + 最近轮换，不显值 -->
        <div
          class="ingress-row"
          data-testid="ingress-row-agent-token"
        >
          <span class="ingress-label">{{ t('settings.security.ingress.agentToken') }}</span>
          <span
            class="ingress-value"
            data-testid="ingress-agent-token-value"
          >
            <template v-if="data?.agentToken.exists">
              <code class="ingress-endpoint">sca_{{ data.agentToken.prefix }}***</code>
              {{ t('settings.security.ingress.issuedAt', { time: formatDateTime(data.agentToken.createdAt) }) }}
              <span
                v-if="data && tokenRotated(data)"
                class="ingress-note"
              >{{ t('settings.security.ingress.rotatedAt', { time: formatDateTime(data.agentToken.rotatedAt) }) }}</span>
            </template>
            <template v-else-if="data">{{ t('settings.security.ingress.agentTokenNone') }}</template>
            <template v-else>—</template>
          </span>
          <n-button
            size="tiny"
            data-testid="ingress-manage-agent-token"
            @click="emit('openTab', 'agentToken')"
          >
            {{ t('settings.security.ingress.manage') }}
          </n-button>
        </div>

        <!-- TLS 与明文回环辅助端口 -->
        <div
          class="ingress-row"
          data-testid="ingress-row-tls"
        >
          <span class="ingress-label">{{ t('settings.security.ingress.tls') }}</span>
          <span
            class="ingress-value"
            data-testid="ingress-tls-value"
          >
            <template v-if="data">
              <template v-if="data.tls.enabled">
                {{ t('settings.security.ingress.tlsOn') }}
                <span class="ingress-note">
                  {{
                    data.tls.loopbackPort > 0
                      ? t('settings.security.ingress.loopbackPort', { port: data.tls.loopbackPort })
                      : t('settings.security.ingress.loopbackNotReady')
                  }}
                </span>
              </template>
              <template v-else>{{ t('settings.security.ingress.tlsOff') }}</template>
            </template>
            <template v-else>—</template>
          </span>
          <n-button
            size="tiny"
            data-testid="ingress-manage-tls"
            @click="emit('openTab', 'tls')"
          >
            {{ t('settings.security.ingress.manage') }}
          </n-button>
        </div>

        <!-- 活跃分享入口：只出计数（明细/token 在分享管理与出域卡承载） -->
        <div
          class="ingress-row"
          data-testid="ingress-row-shares"
        >
          <span class="ingress-label">{{ t('settings.security.ingress.shares') }}</span>
          <span
            class="ingress-value"
            data-testid="ingress-shares-value"
          >
            <template v-if="data && data.shares.count > 0">
              {{ t('settings.security.ingress.sharesCount', { n: data.shares.count }) }}
            </template>
            <template v-else-if="data">{{ t('settings.security.ingress.sharesNone') }}</template>
            <template v-else>—</template>
          </span>
          <n-button
            size="tiny"
            data-testid="ingress-manage-shares"
            @click="goShares"
          >
            {{ t('settings.security.ingress.manage') }}
          </n-button>
        </div>

        <!-- 远程主机：只出数量 -->
        <div
          class="ingress-row"
          data-testid="ingress-row-remote-hosts"
        >
          <span class="ingress-label">{{ t('settings.security.ingress.remoteHosts') }}</span>
          <span
            class="ingress-value"
            data-testid="ingress-remote-hosts-value"
          >
            {{ data ? t('settings.security.ingress.hostsCount', { n: data.remoteHosts.count }) : '—' }}
          </span>
          <n-button
            size="tiny"
            data-testid="ingress-manage-remote-hosts"
            @click="goDeploy"
          >
            {{ t('settings.security.ingress.manage') }}
          </n-button>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped src="./security-settings.css"></style>
