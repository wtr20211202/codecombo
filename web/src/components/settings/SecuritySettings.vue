<script setup lang="ts">
// 安全设置容器：Tab（凭据 / OAuth 应用 / SSH 密钥 / 锁定 / TLS / API Token / Agent Token / 审计日志）
// 容器职责：Tab 编排 + Agent Token / TLS 两个轻分区 inline；其余委托给自包含子组件——
// - 凭据：委托给 CredentialList 子组件（PAT + OAuth Device Flow 统一管理）
// - OAuth 应用：委托给 OAuthClientManager 子组件（client_id CRUD）
// - 审计日志：委托给 AuditLogPane 子组件（服务端分页表格，P-20261002-13）
// - SSH 密钥 / 锁定 / API Token：委托给 SshKeysSettings / LockSettingsPane /
//   AccessTokensSettings 子组件（P-20261002-27 拆分，各自数据自行加载，show=true 刷新，
//   display-directive="show" 常驻挂载与拆分前「容器打开即拉取」同语义）
import { h, ref, watch, onMounted, computed } from 'vue'
import { NButton, NInput, NInputNumber, NSwitch, NTabs, NTabPane, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { agentTokenApi, hookTokenApi, settingsApi, terminalApi, type AgentTokenMeta, type HookTokenMeta } from '../../api/client'
import { copyText } from '../../utils/clipboard'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import CredentialList from './CredentialList.vue'
import OAuthClientManager from './OAuthClientManager.vue'
import AuditLogPane from './AuditLogPane.vue'
import SshKeysSettings from './SshKeysSettings.vue'
import LockSettingsPane from './LockSettingsPane.vue'
import AccessTokensSettings from './AccessTokensSettings.vue'
import ApprovalRulesSettings from './ApprovalRulesSettings.vue'
import { pendingRulePrefill } from '../../composables/useApprovalRuleSuggest'
import SensitivePatternsSettings from './SensitivePatternsSettings.vue'
import ReplaceHistoryPane from './ReplaceHistoryPane.vue'
import EgressOverviewCard from './EgressOverviewCard.vue'
import IngressOverviewCard from './IngressOverviewCard.vue'
import SettingModifiedMark from './SettingModifiedMark.vue'

const props = defineProps<{ show: boolean }>()
// exit：出域总览卡跳主区视图（分享管理）前请宿主收起设置弹层（SettingsModal 转 update:show）
const emit = defineEmits<{ (e: 'exit'): void }>()

const { t } = useI18n()
const message = useMessage()

// 行级「已修改」标记（P-20261003-171，P-20261006-49 分区补全）：安全分区值行
// 的出厂默认（镜像服务端 GET /settings 空值回落与 lock store 默认）。安全分区
// 是即时操作面（无「保存」链），各区块自带保存按钮——恢复钮只复位本区块
// pending 值，仍走该区块既有保存动作落盘（同 P-171 暂存行语义）。
// 令牌/凭据/SSH 密钥/OAuth 应用/审批规则/替换历史是 CRUD 与操作面（无出厂默认
// 可比），按 P-171「无 defaults 行渐进跳过」惯例不挂标记
const SECURITY_DEFAULTS = {
  tlsEnabled: false,
  tlsVerifyPeer: false,
  auditRetentionDays: 30,
  logRetentionDays: 15,
} as const
// 恢复默认的方向性（提案②）：TLS 开关/实例间强校验的出厂默认都是「弱姿态」
// ——恢复默认会把已开启的防护关掉，tooltip 明示方向（不做特殊拦截，设置本身
// 可改，标记只管可见性）
const RESET_TITLE_LOWER = 'settings.resetRowToDefaultLower'

// === Tab 默认值 ===
const activeTab = ref<'credentials' | 'oauthClients' | 'sshKeys' | 'lock' | 'tls' | 'accessTokens' | 'agentToken' | 'hookToken' | 'approvalRules' | 'sensitivePatterns' | 'replaceHistory' | 'audit'>('credentials')

// 审批模式建议「创建规则」深链半程（P-20261006-28）：预填请求由建议条落
// 模块级 ref（window 事件在弹窗关闭时无人接），本容器只负责切到审批规则
// 页签；表单弹窗预填由 ApprovalRulesSettings 消费（pendingRulePrefill 消费
// 即清，两侧不会重复响应同一请求）。immediate 必须带：深链时请求先于本
// 容器挂载已在途（弹窗内容随 show 懒装配），非 immediate 首查不回放会漏
watch([() => props.show, pendingRulePrefill], ([show, prefill]) => {
  if (show && prefill) activeTab.value = 'approvalRules'
}, { immediate: true })

async function load() {
  // 凭据/SSH 密钥/API Token 由各自子组件自行加载，容器无需关心
  await fetchAgentToken()
  await fetchHookToken()
}

// 总览卡的分区内部直达（页签切换）：egress 卡（P-20）= agent token/审计，
// ingress 卡（P-20261004-11）= 锁定/TLS/agent token——同一处理函数，页签键
// 均在本容器 activeTab 联合类型内
function onOverviewOpenTab(tab: 'agentToken' | 'audit' | 'lock' | 'tls') {
  activeTab.value = tab
}

// === Agent Token（sca_，终端内智能体调用本系统 API 的长效令牌） ===
const agentToken = ref<AgentTokenMeta>({ exists: false, prefix: '', createdAt: '', rotatedAt: '' })
const agentTokenPlain = ref('')
const agentTokenRevealed = ref(false)

async function fetchAgentToken() {
  try {
    const res: any = await agentTokenApi.get()
    agentToken.value = res.data || { exists: false, prefix: '', createdAt: '', rotatedAt: '' }
    if (!agentToken.value.exists) agentTokenRevealed.value = false
  } catch { /* silent */ }
}

async function revealAgentToken() {
  try {
    const res: any = await agentTokenApi.reveal()
    agentTokenPlain.value = res.data?.token || ''
    agentTokenRevealed.value = true
  } catch { /* 拦截器处理 */ }
}

async function copyAgentToken() {
  if (await copyText(agentTokenPlain.value)) {
    message.success(t('settings.copied'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

// 运行中 agent 会话数（P-20261003-78 起 / P-20261004-63 改源）：轮换/撤销令牌
// 让运行中会话注入的旧令牌立即失效（工具回调全 423），确认框按数量升级警示。
// 计数改读服务端 GET /terminals/running-count（OSC 133 C/D 帧的服务端权威统计）
// ——此前读本浏览器 runningMap（只由持有连接的宿主写入），手机上轮换时桌面
// 正在跑的会话不在计数里，安全决策建立在单设备视角上。服务端取数失败（旧
// 实例无此端点/网络瞬断）降级回浏览器快照，弱化但不缺失。快照语义不变：
// 确认框是知情报而非轮换瞬间的保证，竞态容忍
const sessionsStore = useTerminalSessionsStore()
const runningAgentCount = ref(0)

async function refreshRunningAgentCount(): Promise<void> {
  try {
    const res: any = await terminalApi.runningCount('agent')
    runningAgentCount.value = res.data?.count ?? 0
  } catch {
    runningAgentCount.value = sessionsStore.sessions.filter(
      s => s.kind !== 'shell' && sessionsStore.runningMap[s.id] === true,
    ).length
  }
}

// 确认文案键按动作显式映射（避免模板串动态键，类型可查）
const TOKEN_ACTION_I18N = {
  rotate: {
    title: 'settings.security.token.rotate.rotateTitle',
    confirm: 'settings.security.token.rotate.rotateConfirm',
  },
  revoke: {
    title: 'settings.security.token.rotate.revokeTitle',
    confirm: 'settings.security.token.rotate.revokeConfirm',
  },
} as const

/** 轮换/撤销共用确认流（立即失效语义，盲点即打断运行中会话）：运行中 agent
 *  会话 >0 时确认框升级为计数警示（撤销同级展示），无运行会话则普通确认。
 *  计数在弹框前现取（服务端现值，非页面加载期的陈旧快照） */
async function confirmAgentTokenAction(action: keyof typeof TOKEN_ACTION_I18N): Promise<boolean> {
  const keys = TOKEN_ACTION_I18N[action]
  await refreshRunningAgentCount()
  const count = runningAgentCount.value
  return confirmDialog({
    title: t(keys.title),
    type: 'warning',
    content: count > 0
      ? () => h('div', { style: 'display:flex;flex-direction:column;gap:6px;' }, [
          h(
            'div',
            { 'data-testid': 'agent-token-running-warning', style: 'color:var(--accent-yellow);' },
            t('settings.security.token.rotate.runningWarning', { count }),
          ),
          h('div', null, t(keys.confirm)),
        ])
      : t(keys.confirm),
  })
}

async function rotateAgentToken() {
  if (!await confirmAgentTokenAction('rotate')) return
  try {
    const res: any = await agentTokenApi.rotate()
    agentTokenPlain.value = res.data?.token || ''
    agentTokenRevealed.value = true
    message.warning(t('settings.security.agentToken.rotateNote'))
    await fetchAgentToken()
  } catch { /* 拦截器处理 */ }
}

async function revokeAgentToken() {
  if (!await confirmAgentTokenAction('revoke')) return
  try {
    await agentTokenApi.revoke()
    agentTokenPlain.value = ''
    agentTokenRevealed.value = false
    await fetchAgentToken()
  } catch { /* 拦截器处理 */ }
}

// === 入站事件 Hook 凭据（sch_，P-20261003-23） ===
// 与 Agent Token 独立权限域：只允许外部事件写通知中心（可选 panel: 动作）、拿
// 不到管理面能力。无凭据 = 入站整体 401；签发/轮换/销毁均为显式动作并入审计。
const hookToken = ref<HookTokenMeta>({ exists: false, prefix: '', createdAt: '', rotatedAt: '' })
const hookTokenPlain = ref('')
const hookTokenBusy = ref(false)

async function fetchHookToken() {
  try {
    const res: any = await hookTokenApi.get()
    hookToken.value = res.data || { exists: false, prefix: '', createdAt: '', rotatedAt: '' }
  } catch { /* silent */ }
}

// curl 示例走 header-only 形态（凭据不进 URL，访问日志零暴露面）；
// $SC_HOOK_TOKEN 由用户自行注入，示例本身不含任何真实凭据
const hookCurlSample = computed(() => {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return [
    `curl -X POST '${origin}/api/hooks' \\`,
    `  -H 'X-Hook-Token: $SC_HOOK_TOKEN' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"title":"CI failed","category":"error","action":"panel:git"}'`,
  ].join('\n')
})

async function rotateHookToken() {
  const existed = hookToken.value.exists
  if (existed) {
    const ok = await confirmDialog({
      title: t('settings.security.hookToken.rotateTitle'),
      type: 'warning',
      content: t('settings.security.hookToken.rotateConfirm'),
    })
    if (!ok) return
  }
  hookTokenBusy.value = true
  try {
    const res: any = await hookTokenApi.rotate()
    hookTokenPlain.value = res.data?.token || ''
    await fetchHookToken()
    message.success(existed
      ? t('settings.security.hookToken.rotated')
      : t('settings.security.hookToken.issued'))
  } catch { /* 拦截器处理 */ } finally {
    hookTokenBusy.value = false
  }
}

async function revokeHookToken() {
  const ok = await confirmDialog({
    title: t('settings.security.hookToken.revokeTitle'),
    type: 'warning',
    content: t('settings.security.hookToken.revokeConfirm'),
  })
  if (!ok) return
  hookTokenBusy.value = true
  try {
    await hookTokenApi.revoke()
    hookTokenPlain.value = ''
    await fetchHookToken()
    message.success(t('settings.security.hookToken.revoked'))
  } catch { /* 拦截器处理 */ } finally {
    hookTokenBusy.value = false
  }
}

async function copyHookTokenPlain() {
  if (await copyText(hookTokenPlain.value)) {
    message.success(t('settings.copied'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

async function copyHookSample() {
  if (await copyText(hookCurlSample.value)) {
    message.success(t('settings.copied'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

// === 入站 Hook URL 动作允许域（P-20261003-164） ===
// action:"url:<链接>" 仅 http(s) 且 host 命中清单才放行入站；空清单 = url
// 动作整体关闭（仅 panel:，默认安全档）。输入形态逗号分隔，权威归一/校验在
// 服务端写路径（config.NormalizeHookURLAllowHosts，非法条目 400 就地提示）；
// 保存即时生效（入站解析每请求现读配置，无需重启）
const hookUrlAllowHosts = ref('')
const savingHookUrlAllow = ref(false)

async function saveHookUrlAllow() {
  if (savingHookUrlAllow.value) return
  savingHookUrlAllow.value = true
  try {
    const hosts = hookUrlAllowHosts.value.split(',').map(s => s.trim()).filter(Boolean)
    await settingsApi.update({ hookUrlAllowHosts: hosts })
    // 服务端归一后的清单回填输入框（小写/去重/剥端口），所见即生效
    const res: any = await settingsApi.get()
    hookUrlAllowHosts.value = (res.data?.hookUrlAllowHosts ?? []).join(', ')
    message.success(t('settings.security.hookToken.urlAllowSaved'))
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('settings.retention.saveFailed'))
  } finally {
    savingHookUrlAllow.value = false
  }
}

// === TLS（HTTPS/WSS）===
// 证书路径后端不回显具体值（只回是否已配置）：输入框留空 = 保持不变，
// 与密码类表单同语义；保存后需重启进程生效（监听器在启动期装配）
const tlsEnabled = ref(false)
const tlsCertConfigured = ref(false)
const tlsCertFile = ref('')
const tlsKeyFile = ref('')
// 实例间 TLS 校验策略：默认 false = TOFU 指纹（自签直达）；true = 系统信任库强校验
const tlsVerifyPeer = ref(false)
const savingVerifyPeer = ref(false)

// === 数据保留期（P-20261003-123）===
// 审计事件与运行日志的保留天数：合规留档调长 / 磁盘紧张调短。生效路径由
// 服务端清理巡检读配置承载（每日巡更，无需重启）；0/1~3650 边界在服务端
// 校验，前端钳 1~3650（0=回落默认的逃生口保留在 API 层，UI 不暴露避免
// 「0 是什么」的困惑——输入框恒显生效值）
const auditRetentionDays = ref<number | null>(30)
const logRetentionDays = ref<number | null>(15)
const savingRetention = ref(false)

// === 敏感文件外部改动观测（P-20261005-15）===
// watcher 命中敏感模式（.env/密钥/凭据类）且非工作台自身写入 → 审计
// project.file.external + 通知中心条目。默认开（工作台外敏感写入是审计链
// 边界盲区）；关闭即时生效（服务端判定点现读配置，无需重启）
const sensitiveExternalWatch = ref(true)
const savingExternalWatch = ref(false)

async function saveExternalWatch() {
  if (savingExternalWatch.value) return
  savingExternalWatch.value = true
  try {
    await settingsApi.update({ sensitiveExternalWatch: sensitiveExternalWatch.value })
    message.success(t('settings.retention.externalWatchSaved'))
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('settings.retention.saveFailed'))
  } finally {
    savingExternalWatch.value = false
  }
}

async function saveRetention() {
  if (savingRetention.value) return
  savingRetention.value = true
  try {
    await settingsApi.update({
      auditRetentionDays: auditRetentionDays.value ?? 0,
      logRetentionDays: logRetentionDays.value ?? 0,
    })
    message.success(t('settings.retention.saved'))
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('settings.retention.saveFailed'))
  } finally {
    savingRetention.value = false
  }
}

async function loadTlsSettings() {
  try {
    const res: any = await settingsApi.get()
    tlsEnabled.value = !!res.data?.tlsEnabled
    tlsCertConfigured.value = !!res.data?.tlsCertConfigured
    // 实例间 TLS 校验策略：默认 TOFU 指纹（false=跳过信任库校验）
    tlsVerifyPeer.value = !!res.data?.tlsVerifyPeer
    // 数据保留期（P-20261003-123）：GET 出参为生效值（未配置时服务端已填默认 30/15）
    auditRetentionDays.value = res.data?.auditRetentionDays ?? 30
    logRetentionDays.value = res.data?.logRetentionDays ?? 15
    // 敏感文件外部改动观测（P-20261005-15）：GET 出参为生效值（未配置服务端默认开）
    sensitiveExternalWatch.value = res.data?.sensitiveExternalWatch !== false
    // 入站 Hook URL 动作允许域（P-20261003-164）：恒返数组，逗号串回显
    hookUrlAllowHosts.value = (res.data?.hookUrlAllowHosts ?? []).join(', ')
  } catch { /* silent */ }
}

// 实例间 TLS 校验策略保存：即时生效（客户端按当前策略连接，无需重启）
async function saveVerifyPeer() {
  savingVerifyPeer.value = true
  try {
    await settingsApi.update({ tlsVerifyPeer: tlsVerifyPeer.value })
    message.success(t('settings.tls.verifyPeerSaved'))
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('settings.tls.saveFailed'))
  } finally {
    savingVerifyPeer.value = false
  }
}

async function saveTls() {
  try {
    await settingsApi.update({
      tlsEnabled: tlsEnabled.value,
      // 留空不传（nil = 后端保持原值），只在用户显式输入时覆盖
      ...(tlsCertFile.value ? { tlsCertFile: tlsCertFile.value } : {}),
      ...(tlsKeyFile.value ? { tlsKeyFile: tlsKeyFile.value } : {}),
    })
    tlsCertConfigured.value = tlsCertConfigured.value || (!!tlsCertFile.value && !!tlsKeyFile.value)
    tlsCertFile.value = ''
    tlsKeyFile.value = ''
    message.success(t('settings.tls.savedRestart'))
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('settings.tls.saveFailed'))
  }
}

onMounted(() => {
  if (props.show) {
    load()
    loadTlsSettings()
  }
})
watch(() => props.show, (val) => {
  if (val) {
    load()
    loadTlsSettings()
  }
})

defineExpose({ load })
</script>

<template>
  <div class="security-settings">
    <!-- 数据出域面总览卡（P-20261003-20）+ 入口面总览卡（P-20261004-11）：
         安全姿态一页（出/入两翼对称），Tabs 上方常显 -->
    <EgressOverviewCard
      :show="show"
      @open-tab="onOverviewOpenTab"
      @exit="emit('exit')"
    />
    <IngressOverviewCard
      :show="show"
      @open-tab="onOverviewOpenTab"
      @exit="emit('exit')"
    />
    <n-tabs
      v-model:value="activeTab"
      type="line"
      size="small"
    >
      <!-- 凭据：PAT + OAuth Device Flow，委托给 CredentialList 子组件 -->
      <n-tab-pane
        name="credentials"
        :tab="t('settings.security.tabs.credentials')"
      >
        <CredentialList />
      </n-tab-pane>

      <!-- OAuth 应用：client_id CRUD，委托给 OAuthClientManager 子组件 -->
      <n-tab-pane
        name="oauthClients"
        :tab="t('settings.security.tabs.oauthClients')"
      >
        <OAuthClientManager />
      </n-tab-pane>

      <!-- SSH 密钥：委托给 SshKeysSettings 子组件（生成/导入/删除/公钥复制） -->
      <n-tab-pane
        name="sshKeys"
        :tab="t('settings.security.tabs.sshKeys')"
        display-directive="show"
      >
        <SshKeysSettings :show="show" />
      </n-tab-pane>

      <!-- 锁定：委托给 LockSettingsPane 子组件（配置/改密/立即锁定/快捷键） -->
      <n-tab-pane
        name="lock"
        :tab="t('settings.security.tabs.lock')"
        display-directive="show"
      >
        <LockSettingsPane :show="show" />
      </n-tab-pane>

      <!-- TLS（HTTPS/WSS）：保存后需重启生效 -->
      <n-tab-pane
        name="tls"
        :tab="t('settings.tls.tab')"
      >
        <div class="tab-section">
          <h4 class="section-title">
            {{ t('settings.tls.section') }}
          </h4>
          <div class="lock-section">
            <p class="lock-now-desc">
              {{ t('settings.tls.desc') }}
            </p>
            <div
              class="cred-row"
              data-testid="settings-tls-enable"
            >
              <span>{{ t('settings.tls.enable') }}</span>
              <div class="cred-row-end">
                <n-switch v-model:value="tlsEnabled" />
                <SettingModifiedMark
                  :modified="tlsEnabled !== SECURITY_DEFAULTS.tlsEnabled"
                  :restore-title="t(RESET_TITLE_LOWER)"
                  @restore="tlsEnabled = SECURITY_DEFAULTS.tlsEnabled"
                />
              </div>
            </div>
            <n-input
              v-model:value="tlsCertFile"
              size="small"
              :disabled="!tlsEnabled"
              :title="!tlsEnabled ? t('settings.tls.requiresEnable') : undefined"
              :placeholder="tlsCertConfigured ? t('settings.tls.certConfigured') : t('settings.tls.certPlaceholder')"
            />
            <n-input
              v-model:value="tlsKeyFile"
              size="small"
              :disabled="!tlsEnabled"
              :title="!tlsEnabled ? t('settings.tls.requiresEnable') : undefined"
              :placeholder="tlsCertConfigured ? t('settings.tls.keyConfigured') : t('settings.tls.keyPlaceholder')"
            />
            <p class="lock-now-desc">
              {{ t('settings.tls.hint') }}
            </p>
            <n-button
              size="small"
              type="primary"
              @click="saveTls"
            >
              {{ t('common.save') }}
            </n-button>
          </div>

          <!-- 实例间 TLS 证书校验：默认 TOFU 指纹（免信任库导入），可开启强校验 -->
          <div class="lock-section">
            <h4 class="section-title">
              {{ t('settings.tls.peerSection') }}
            </h4>
            <p class="lock-now-desc">
              {{ t('settings.tls.peerDesc') }}
            </p>
            <div
              class="cred-row"
              data-testid="settings-tls-verify-peer"
            >
              <span>{{ t('settings.tls.verifyPeer') }}</span>
              <div class="cred-row-end">
                <n-switch v-model:value="tlsVerifyPeer" />
                <SettingModifiedMark
                  :modified="tlsVerifyPeer !== SECURITY_DEFAULTS.tlsVerifyPeer"
                  :restore-title="t(RESET_TITLE_LOWER)"
                  @restore="tlsVerifyPeer = SECURITY_DEFAULTS.tlsVerifyPeer"
                />
              </div>
            </div>
            <p class="lock-now-desc">
              {{ t('settings.tls.verifyPeerHint') }}
            </p>
            <n-button
              size="small"
              :loading="savingVerifyPeer"
              @click="saveVerifyPeer"
            >
              {{ t('common.save') }}
            </n-button>
          </div>
        </div>
      </n-tab-pane>

      <!-- API Token：委托给 AccessTokensSettings 子组件（签发/删除/长效边界警示） -->
      <n-tab-pane
        name="accessTokens"
        :tab="t('settings.security.tabs.accessTokens')"
        display-directive="show"
      >
        <AccessTokensSettings :show="show" />
      </n-tab-pane>

      <!-- Agent Token：终端内智能体（claude/codex/dsh）调用本系统 API 的长效令牌 -->
      <n-tab-pane
        name="agentToken"
        :tab="t('settings.security.agentToken.tab')"
      >
        <div class="tab-section">
          <p class="lock-now-desc">
            {{ t('settings.security.agentToken.desc') }}
          </p>
          <!-- 常显边界说明：sca_ 不随解锁 TTL 过期，泄露只能靠 rotate 补救（区别于 rotate 后的瞬时提示） -->
          <p
            class="lock-now-desc token-longlived-line"
            data-testid="agent-token-boundary"
          >
            <span class="token-longlived-badge">{{ t('settings.security.token.longLivedBadge') }}</span>
            {{ t('settings.security.token.agentBoundary') }}
          </p>
          <div class="token-add-row">
            <code
              v-if="agentToken.exists"
              class="token-prefix"
            >sca_{{ agentToken.prefix }}***</code>
            <code
              v-else
              class="token-prefix"
            >sca_***</code>
            <span style="flex: 1" />
            <n-button
              v-if="!agentTokenRevealed"
              size="tiny"
              @click="revealAgentToken"
            >
              {{ t('settings.security.agentToken.reveal') }}
            </n-button>
            <template v-else>
              <code class="token-plain">{{ agentTokenPlain }}</code>
              <n-button
                size="tiny"
                @click="copyAgentToken"
              >
                {{ t('settings.copyToken') }}
              </n-button>
            </template>
          </div>
          <div class="token-add-row">
            <n-button
              size="small"
              @click="rotateAgentToken"
            >
              {{ t('settings.security.agentToken.rotate') }}
            </n-button>
            <n-button
              size="small"
              quaternary
              type="error"
              :disabled="!agentToken.exists"
              @click="revokeAgentToken"
            >
              {{ t('settings.security.agentToken.revoke') }}
            </n-button>
          </div>
          <p class="lock-now-desc">
            {{ t('settings.security.agentToken.rotateNote') }}
          </p>
        </div>
      </n-tab-pane>

      <!-- 入站事件 Hook（P-20261003-23）：外部事件（CI/监控/脚本）→ 通知中心，
           可选 panel: 动作直达面板。独立 sch_ 凭据与 Agent Token 分权限域 -->
      <n-tab-pane
        name="hookToken"
        :tab="t('settings.security.hookToken.tab')"
      >
        <div class="tab-section">
          <p class="lock-now-desc">
            {{ t('settings.security.hookToken.desc') }}
          </p>
          <p
            class="lock-now-desc token-longlived-line"
            data-testid="hook-token-boundary"
          >
            <span class="token-longlived-badge">{{ t('settings.security.hookToken.badge') }}</span>
            {{ t('settings.security.hookToken.boundary') }}
          </p>
          <div class="token-add-row">
            <code
              v-if="hookToken.exists"
              class="token-prefix"
              data-testid="hook-token-prefix"
            >sch_{{ hookToken.prefix }}***</code>
            <code
              v-else
              class="token-prefix"
              data-testid="hook-token-prefix"
            >sch_***</code>
            <span style="flex: 1" />
            <n-button
              size="small"
              type="primary"
              data-testid="hook-token-rotate"
              :loading="hookTokenBusy"
              @click="rotateHookToken"
            >
              {{ hookToken.exists ? t('settings.security.hookToken.rotate') : t('settings.security.hookToken.issue') }}
            </n-button>
            <n-button
              size="small"
              quaternary
              type="error"
              data-testid="hook-token-revoke"
              :disabled="!hookToken.exists"
              :loading="hookTokenBusy"
              @click="revokeHookToken"
            >
              {{ t('settings.security.hookToken.revoke') }}
            </n-button>
          </div>
          <div
            v-if="hookTokenPlain"
            class="token-result"
            data-testid="hook-token-plain"
          >
            <div class="token-result-title">
              {{ t('settings.security.hookToken.plainTitle') }}
            </div>
            <code class="token-plain">{{ hookTokenPlain }}</code>
            <n-button
              size="tiny"
              @click="copyHookTokenPlain"
            >
              {{ t('settings.copyToken') }}
            </n-button>
            <p class="lock-now-desc">
              {{ t('settings.security.hookToken.plainHint') }}
            </p>
          </div>
          <p class="lock-now-desc">
            {{ t('settings.security.hookToken.endpointHint') }}
          </p>
          <pre
            class="hook-curl-sample"
            data-testid="hook-token-sample"
          >{{ hookCurlSample }}</pre>
          <div class="token-add-row">
            <n-button
              size="tiny"
              @click="copyHookSample"
            >
              {{ t('settings.security.hookToken.copySample') }}
            </n-button>
          </div>
          <p class="lock-now-desc">
            {{ t('settings.security.hookToken.bodyHint') }}
          </p>
          <p class="lock-now-desc">
            {{ t('settings.security.hookToken.limitHint') }}
          </p>
          <!-- URL 动作允许域（P-20261003-164）：action:"url:<链接>" 的放行边界
               ——空清单 = url 动作整体关闭（仅 panel:，默认安全档） -->
          <p
            class="lock-now-desc"
            data-testid="hook-url-allow-desc"
          >
            {{ t('settings.security.hookToken.urlAllowDesc') }}
          </p>
          <div class="token-add-row">
            <n-input
              v-model:value="hookUrlAllowHosts"
              size="small"
              :placeholder="t('settings.security.hookToken.urlAllowPlaceholder')"
              data-testid="hook-url-allow-input"
            />
            <n-button
              size="small"
              type="primary"
              :loading="savingHookUrlAllow"
              data-testid="hook-url-allow-save"
              @click="saveHookUrlAllow"
            >
              {{ t('settings.security.hookToken.urlAllowSave') }}
            </n-button>
          </div>
          <p class="lock-now-desc">
            {{ t('settings.security.hookToken.urlAllowHint') }}
          </p>
          <p
            v-if="hookToken.exists"
            class="lock-now-desc"
            data-testid="hook-token-dates"
          >
            {{ t('settings.security.hookToken.dates', { created: hookToken.createdAt, rotated: hookToken.rotatedAt }) }}
          </p>
        </div>
      </n-tab-pane>

      <!-- 审批分类规则（P-20261003-35）：per-op 自动裁决规则表 CRUD + 命中测试 -->
      <n-tab-pane
        name="approvalRules"
        :tab="t('approval.rules.tab')"
        display-directive="show"
      >
        <ApprovalRulesSettings :show="show" />
      </n-tab-pane>

      <!-- 自定义敏感模式（P-20261006-11）：项目自有 secret 的正则表达，双端
           （Go 敏感面 ×3 / TS sensitiveMask 链）同源消费 -->
      <n-tab-pane
        name="sensitivePatterns"
        :tab="t('settings.security.sensitivePatterns.tab')"
        display-directive="show"
      >
        <SensitivePatternsSettings :show="show" />
      </n-tab-pane>

      <!-- 替换历史（P-20261004-66）：批量替换留档与一键还原（数据自包含加载，
           show=true 拉取，项目选择器默认跟随当前项目） -->
      <n-tab-pane
        name="replaceHistory"
        :tab="t('settings.security.replaceHistory.tab')"
        display-directive="show"
      >
        <ReplaceHistoryPane :show="show" />
      </n-tab-pane>

      <!-- 审计日志：安全事件时间线（谁在何时从哪个 IP 干了什么），委托给 AuditLogPane；
           分区头部为数据保留期（P-20261003-123）——审计/运行日志留存天数双向可调 -->
      <n-tab-pane
        name="audit"
        :tab="t('audit.tab')"
      >
        <div
          class="tab-section retention-section"
          data-testid="settings-retention"
        >
          <h4 class="section-title">
            {{ t('settings.retention.section') }}
          </h4>
          <p class="lock-now-desc">
            {{ t('settings.retention.desc') }}
          </p>
          <div class="cred-row">
            <span>{{ t('settings.retention.auditDays') }}</span>
            <div class="cred-row-end">
              <n-input-number
                v-model:value="auditRetentionDays"
                size="small"
                :min="1"
                :max="3650"
                :step="1"
                :precision="0"
                style="width: 120px"
                data-testid="settings-audit-retention-days"
              />
              <SettingModifiedMark
                :modified="(auditRetentionDays ?? 0) !== SECURITY_DEFAULTS.auditRetentionDays"
                @restore="auditRetentionDays = SECURITY_DEFAULTS.auditRetentionDays"
              />
            </div>
          </div>
          <div class="cred-row">
            <span>{{ t('settings.retention.logDays') }}</span>
            <div class="cred-row-end">
              <n-input-number
                v-model:value="logRetentionDays"
                size="small"
                :min="1"
                :max="3650"
                :step="1"
                :precision="0"
                style="width: 120px"
                data-testid="settings-log-retention-days"
              />
              <SettingModifiedMark
                :modified="(logRetentionDays ?? 0) !== SECURITY_DEFAULTS.logRetentionDays"
                @restore="logRetentionDays = SECURITY_DEFAULTS.logRetentionDays"
              />
            </div>
          </div>
          <p
            class="lock-now-desc"
            style="color: var(--accent-yellow);"
          >
            {{ t('settings.retention.diskNote') }}
          </p>
          <n-button
            size="small"
            type="primary"
            :loading="savingRetention"
            data-testid="settings-retention-save"
            @click="saveRetention"
          >
            {{ t('common.save') }}
          </n-button>
        </div>
        <!-- 敏感文件外部改动观测（P-20261005-15）：工作台外写入的边界可见性，
             与保留期同属审计观测面——开关置其下、审计表格之上 -->
        <div
          class="tab-section retention-section"
          data-testid="settings-external-watch"
        >
          <h4 class="section-title">
            {{ t('settings.retention.externalWatch') }}
          </h4>
          <p class="lock-now-desc">
            {{ t('settings.retention.externalWatchDesc') }}
          </p>
          <div class="cred-row">
            <span>{{ t('settings.retention.externalWatch') }}</span>
            <n-switch
              v-model:value="sensitiveExternalWatch"
              data-testid="settings-external-watch-switch"
            />
          </div>
          <n-button
            size="small"
            type="primary"
            :loading="savingExternalWatch"
            data-testid="settings-external-watch-save"
            @click="saveExternalWatch"
          >
            {{ t('common.save') }}
          </n-button>
        </div>
        <AuditLogPane />
      </n-tab-pane>
    </n-tabs>
  </div>
</template>

<style scoped src="./security-settings.css"></style>
