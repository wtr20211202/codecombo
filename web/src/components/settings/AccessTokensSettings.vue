<script setup lang="ts">
// API Token 设置 Tab（自 SecuritySettings 按区块拆出，P-20261002-27）：
// 与 Git 凭据独立的访问令牌（sc_）签发/删除 + 长效令牌边界警示（P-20261001-25）。
// 自包含：数据自行加载；show=true 时（重新）拉取，与原容器每次打开设置即刷新同语义。
import { ref, computed, watch, onMounted } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { tokenApi } from '../../api/client'
import { copyText } from '../../utils/clipboard'
import { useMessage } from 'naive-ui'

const props = defineProps<{ show: boolean }>()

const { t } = useI18n()
const message = useMessage()

// === Token 状态（API Token，与 Git 凭据独立） ===
const tokens = ref<Array<{ id: string; name: string; prefix: string; expiresAt: string; createdAt: string; lastUsedAt: string }>>([])
const newTokenName = ref('')
const newTokenExpiry = ref(0)
const showTokenResult = ref(false)
const createdTokenPlain = ref('')
const tokenLoading = ref(false)

// === 长效令牌边界警示（P-20261001-25）===
// access token 独立于锁定 store 且 /proxy/* 豁免锁定——一旦签发，锁定重新生效后仍然有效。
// expiry ≥90 天或永久（0）视为长效，签发决策须带完整信息（默认选中「永久」即警示）
const showLongLivedWarning = computed(() => newTokenExpiry.value === 0 || newTokenExpiry.value >= 90)

// 列表行长效判定：永久（后端 expiresInDays=0 时不回填 expiresAt）或距过期 >90 天，
// 与签发警示同一边界语义；过期/短期令牌不加徽标
function isLongLivedToken(expiresAt: string): boolean {
  if (!expiresAt) return true
  return Date.parse(expiresAt) - Date.now() > 90 * 24 * 60 * 60 * 1000
}

async function load() {
  newTokenName.value = ''
  showTokenResult.value = false
  await fetchTokens()
}

// === Token CRUD ===
async function fetchTokens() {
  try {
    const res: any = await tokenApi.list()
    tokens.value = res.data || []
  } catch { /* silent */ }
}

async function createToken() {
  if (!newTokenName.value) return
  tokenLoading.value = true
  try {
    const res: any = await tokenApi.create({ name: newTokenName.value, expiresInDays: newTokenExpiry.value })
    createdTokenPlain.value = res.data?.token || ''
    showTokenResult.value = true
    newTokenName.value = ''
    await fetchTokens()
  } catch { /* 拦截器处理 */ }
  finally { tokenLoading.value = false }
}

// 删除确认（P-20261005-5）：令牌删除即刻杀死在用调用（/proxy 与远程实例链）、
// 明文不再复现须重签发重部署——删除族中影响最大，与 Agent Token 撤销确认同款知情语义
async function deleteToken(tk: { id: string; name: string }) {
  const ok = await confirmDialog({
    title: t('settings.security.token.deleteTitle', { name: tk.name }),
    content: t('settings.security.token.deleteConfirm'),
    type: 'warning',
    confirmText: t('common.delete'),
  })
  if (!ok) return
  try {
    await tokenApi.delete(tk.id)
    await fetchTokens()
  } catch { /* 拦截器处理 */ }
}

async function copyToken() {
  // copyText 内含 secure context 降级；失败时提示而不是假成功
  if (await copyText(createdTokenPlain.value)) {
    message.success(t('settings.copied'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

onMounted(() => {
  if (props.show) load()
})
watch(() => props.show, (val) => {
  if (val) load()
})
</script>

<template>
  <div class="tab-section">
    <p class="lock-now-desc">
      {{ t('settings.atRestBoundary') }}
    </p>
    <div class="token-add-row">
      <n-input
        v-model:value="newTokenName"
        size="small"
        style="flex: 1"
        :placeholder="t('settings.tokenDescPlaceholder')"
      />
      <n-select
        v-model:value="newTokenExpiry"
        size="small"
        style="width: 110px"
        :options="[
          { label: t('settings.tokenPermanent'), value: 0 },
          { label: t('settings.tokenDays', { n: 7 }), value: 7 },
          { label: t('settings.tokenDays', { n: 30 }), value: 30 },
          { label: t('settings.tokenDays', { n: 90 }), value: 90 },
          { label: t('settings.tokenYear'), value: 365 },
        ]"
      />
      <n-button
        size="small"
        type="primary"
        :disabled="!newTokenName"
        :loading="tokenLoading"
        @click="createToken"
      >
        {{ t('settings.generateToken') }}
      </n-button>
    </div>
    <!-- 长效 expiry（≥90 天/永久）签发警示：随 expiry 选择即时显隐 -->
    <div
      v-if="showLongLivedWarning"
      class="cred-warn token-longlived-warning"
      data-testid="token-longlived-warning"
    >
      {{ t('settings.security.token.longLivedWarning') }}
    </div>
    <div
      v-if="showTokenResult"
      class="token-result"
    >
      <div class="token-result-title">
        {{ t('settings.tokenGenerated') }}
      </div>
      <code class="token-plain">{{ createdTokenPlain }}</code>
      <n-button
        size="tiny"
        @click="copyToken"
      >
        {{ t('settings.copyToken') }}
      </n-button>
    </div>
    <div class="token-list">
      <div
        v-for="tk in tokens"
        :key="tk.id"
        class="token-item"
      >
        <code class="token-prefix">sc_{{ tk.prefix }}***</code>
        <span class="token-name">{{ tk.name }}</span>
        <!-- 长效令牌徽标：永久或距过期 >90 天，悬浮显示完整边界说明 -->
        <span
          v-if="isLongLivedToken(tk.expiresAt)"
          class="token-longlived-badge"
          data-testid="token-longlived-badge"
          :title="t('settings.security.token.longLivedWarning')"
        >{{ t('settings.security.token.longLivedBadge') }}</span>
        <span
          v-if="tk.expiresAt"
          class="token-expiry"
        >{{ tk.expiresAt.slice(0, 10) }}</span>
        <span style="flex: 1" />
        <n-button
          size="tiny"
          quaternary
          type="error"
          @click="deleteToken(tk)"
        >
          {{ t('settings.deleteToken') }}
        </n-button>
      </div>
      <div
        v-if="tokens.length === 0"
        class="pane-empty"
      >
        {{ t('settings.noTokens') }}
      </div>
    </div>
  </div>
</template>

<style scoped src="./security-settings.css"></style>
