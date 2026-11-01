<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { NCard, NButton, NEmpty, NIcon, NSpin } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { tunnelApi, type RemoteTunnel } from '../../api/domains/remote'
import { useRemoteHostStore } from '../../stores/remoteHost'

/**
 * 活跃隧道行集（P-20261004-19）：远程穿透链路观测入口——设置·远程部署分区
 * 消费既有 GET /api/remotehosts/:id/tunnels（此前仅 agent 手册可达，UI 无
 * 消费面）。行 =「主机名 + remote:N → local:M 映射 + 空闲剩余 TTL 估算 +
 * 手动关闭」，低频观测语义：仅分区可见时拉取 + 20s 轮询（不开 WS）；
 * 关闭走既有 DELETE 端点，失败经拦截器 toast 可重试，预览再次联动时
 * 隧道自动重建（既有自愈语义，关了也不破坏预览）。
 */
const props = defineProps<{
  /** 分区可见（设置弹窗开 且 停在远程部署页签）才轮询；隐藏即停 */
  active: boolean
}>()

const { t } = useI18n()
const hostStore = useRemoteHostStore()

/** 带主机名的隧道行（列表端点按 hostId 寻址，展示侧补名称免再查） */
interface TunnelRow extends RemoteTunnel {
  hostName: string
}

const rows = ref<TunnelRow[]>([])
const loading = ref(false)
const closing = ref<Record<string, boolean>>({})
// TTL 剩余估算基准时刻：随每次拉取刷新（20s 步进与分钟级「约」文案匹配，
// 不另起秒级 ticker 避免无谓重渲染）
const nowTs = ref(Date.now())

// 与服务端 sshclient.DefaultTunnelTTL（15min 空闲回收）对齐的展示口径。
// 只作估算展示：真实回收以服务端 30s 扫描为准，最后活跃后未满窗口即「约 N 分钟」
const TUNNEL_TTL_MS = 15 * 60 * 1000

function rowKey(r: TunnelRow): string {
  return `${r.hostId}:${r.localPort}`
}

function remainMin(r: TunnelRow): number {
  const idle = nowTs.value - new Date(r.lastActive).getTime()
  // 下限 1：已逾窗未及被扫描回收的窗口（≤30s）仍按分钟粒度显示「约 1 分钟」
  return Math.max(1, Math.ceil((TUNNEL_TTL_MS - idle) / 60_000))
}

async function fetchTunnels() {
  // 主机清单未就绪（分区先于 load 完成打开）时先补拉一次，免首轮空扫后
  // 干等 20s 轮询才见行
  if (hostStore.hosts.length === 0) {
    await hostStore.fetch().catch(() => { /* 网络抖动下轮自愈 */ })
  }
  // FTP 主机无 SSH 隧道能力（OpenTunnel 对 FTP 400），跳过省无谓请求
  const hosts = hostStore.hosts.filter(h => h.protocol !== 'ftp')
  if (hosts.length === 0) {
    rows.value = []
    return
  }
  loading.value = true
  try {
    // 逐主机并行扇出既有列表端点（主机量级为个位数~十位，且每台是一次
    // 内存 map 读，无 SSH 拨号）；silent + 逐台 catch：观测面失败不打扰，
    // 保留上次结果下轮自愈
    const lists = await Promise.all(
      hosts.map(async h => ({
        host: h,
        list: await tunnelApi.list(h.id, { silent: true }).catch(() => null),
      })),
    )
    // 全部主机拉取失败（网络抖动/锁定态窗口）：保留上次行集不清空——
    // 观测面失败不能误报成「暂无活跃隧道」，下轮自愈
    if (lists.every(l => l.list === null)) return
    const next: TunnelRow[] = []
    for (const { host, list } of lists) {
      for (const tn of ((list as unknown as { data?: RemoteTunnel[] })?.data || [])) {
        next.push({ ...tn, hostName: host.name })
      }
    }
    next.sort((a, b) =>
      a.hostName.localeCompare(b.hostName) || a.localPort - b.localPort)
    rows.value = next
    nowTs.value = Date.now()
  } finally {
    loading.value = false
  }
}

async function closeTunnel(r: TunnelRow) {
  const key = rowKey(r)
  closing.value[key] = true
  try {
    await tunnelApi.close(r.hostId, r.localPort)
    // 关闭即刷新行集（反馈闭环）；预览若仍开着会按既有语义重新建隧道，
    // 下一轮轮询/刷新如实回显
    await fetchTunnels()
  } finally {
    delete closing.value[key]
  }
}

// 低频轮询：仅分区可见期间运行（打开即拉一次 + 20s 周期），隐藏即停——
// 隧道列表是低频观测面，常驻轮询纯属浪费
const POLL_MS = 20_000
let timer: ReturnType<typeof setInterval> | null = null

function stopPolling() {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

watch(() => props.active, (on) => {
  stopPolling()
  if (on) {
    void fetchTunnels()
    timer = setInterval(() => { void fetchTunnels() }, POLL_MS)
  }
}, { immediate: true })

onBeforeUnmount(stopPolling)
</script>

<template>
  <n-card
    size="small"
    :title="t('deploy.tunnels.section')"
    style="margin-bottom: 16px"
    data-testid="tunnel-panel"
  >
    <template #header-extra>
      <n-button
        size="tiny"
        quaternary
        :loading="loading"
        :title="t('common.refresh')"
        data-testid="tunnel-refresh"
        @click="fetchTunnels"
      >
        <template #icon>
          <n-icon :component="RefreshOutline" />
        </template>
      </n-button>
    </template>

    <n-spin
      :show="loading"
      size="small"
    >
      <n-empty
        v-if="rows.length === 0"
        :description="t('deploy.tunnels.empty')"
      />
      <div
        v-else
        class="tunnel-rows"
      >
        <div
          v-for="r in rows"
          :key="rowKey(r)"
          class="tunnel-row"
          data-testid="tunnel-row"
        >
          <span
            class="tunnel-host"
            :title="r.hostName"
          >{{ r.hostName }}</span>
          <span class="tunnel-mapping">
            {{ t('deploy.tunnels.mapping', { remote: r.remotePort, local: r.localPort }) }}
          </span>
          <span class="tunnel-ttl">{{ t('deploy.tunnels.idleRemain', { min: remainMin(r) }) }}</span>
          <n-button
            size="tiny"
            quaternary
            type="error"
            :loading="closing[rowKey(r)]"
            data-testid="tunnel-close"
            @click="closeTunnel(r)"
          >
            {{ t('deploy.tunnels.close') }}
          </n-button>
        </div>
      </div>
    </n-spin>

    <div class="tunnel-hint">
      {{ t('deploy.tunnels.hint') }}
    </div>
  </n-card>
</template>

<style scoped>
.tunnel-rows { display: flex; flex-direction: column; gap: 6px; }
.tunnel-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border-color);
  border-radius: 4px;
}
.tunnel-host {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: var(--text-primary);
  flex-shrink: 0;
}
/* 映射与 TTL 是端口数字串：等宽字体 + 防逐字换行（同 .host-detail 口径） */
.tunnel-mapping {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.tunnel-ttl {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-muted);
}
.tunnel-hint {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
