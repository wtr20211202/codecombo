<script setup lang="ts">
// 凭据列表形态注记（P-20261004-136 盘点）：本列表是 NList 行卡（NThing 内容
// 自适应行高），非数据表——无表头、无固定列义，sticky 表头不适用（与通知中心
// 同款「行卡不适用」判定）；安全域唯一的长数据表是 AuditLogPane（sticky 已开）。
import { ref, computed, onMounted } from 'vue'
import {
  NList, NListItem, NThing, NTag, NSpace, NButton, NEmpty,
  NModal, NForm, NFormItem, NInput, NSelect, useMessage,
} from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { credentialApi, remoteApi, type Credential, type TestCredentialResp } from '../../api/client'
import { useProjectStore } from '../../stores/project'
import { confirmDialog } from '../../composables/useDialog'
import { friendlyRemoteError } from '../../utils/remoteErrors'
import OAuthDeviceFlowDialog from './OAuthDeviceFlowDialog.vue'

const { t } = useI18n()
const message = useMessage()
const projectStore = useProjectStore()

// 凭据列表（PAT / OAuth Device / OAuth Web 统一展示）
const creds = ref<Credential[]>([])
// 「添加 PAT」弹窗显隐
const showAddPAT = ref(false)
const saving = ref(false)
// 新 PAT 表单字段（platform 空字符串 = 自动识别）
const newCred = ref({ host: '', username: '', secret: '', platform: '' })
// 平台下拉选项：自动识别 + 5 个平台（手动指定用于本地自建服务）
const platformOptions = computed(() => [
  { label: t('settings.security.credentials.platformAuto'), value: '' },
  { label: t('credential.platform.github'), value: 'github' },
  { label: t('credential.platform.gitlab'), value: 'gitlab' },
  { label: t('credential.platform.gitea'), value: 'gitea' },
  { label: t('credential.platform.gitee'), value: 'gitee' },
  { label: t('credential.platform.generic'), value: 'generic' },
])
// generic 平台测试弹窗：ls-remote 需要仓库 URL
const showTestRepo = ref(false)
const testRepoUrl = ref('')
const testTargetCred = ref<Credential | null>(null)
const testing = ref(false)

// OAuth Device Flow 弹窗状态：platform/host 由调用方决定
const oauthDialog = ref({
  show: false,
  platform: 'github' as 'github' | 'gitea',
  host: '',
})

// 拉取凭据列表
// 注意：response 拦截器已 unwrap 返回 body（res.data 是 body 本身），
// 但 axios 类型签名仍按 AxiosResponse 暴露，沿用项目惯例 `const res: any` 处理 unwrap。
async function fetchCreds() {
  try {
    const res: any = await credentialApi.list()
    creds.value = (res?.data as Credential[] | undefined) ?? []
  } catch {
    // 拦截器统一处理
  }
}

onMounted(fetchCreds)

// 保存 PAT（auth_type=basic）
async function saveCred() {
  if (!newCred.value.host || !newCred.value.secret) {
    message.warning(t('settings.security.credentials.requiredFields'))
    return
  }
  saving.value = true
  try {
    await credentialApi.save({
      host: newCred.value.host,
      username: newCred.value.username,
      secret: newCred.value.secret,
      auth_type: 'basic',
      platform: newCred.value.platform || undefined,
    })
    message.success(t('common.saved'))
    showAddPAT.value = false
    newCred.value = { host: '', username: '', secret: '', platform: '' }
    await fetchCreds()
  } catch (e: any) {
    message.error(e?.userMessage || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

// 删除凭据（delete 是关键字，client.ts 中方法名是 remove）
async function deleteCred(cred: Credential) {
  const ok = await confirmDialog({
    title: t('settings.security.credentials.deleteConfirm', { host: cred.host }),
    type: 'warning',
    confirmText: t('common.delete'),
  })
  if (!ok) return
  try {
    await credentialApi.remove(cred.id)
    await fetchCreds()
  } catch {
    // 拦截器统一处理
  }
}

// 测试连接：有当前项目 remote 时优先走 ls-remote（最贴近实际 git 操作，不依赖 /user API 权限）；
// 否则 generic/未识别平台弹窗手填仓库 URL，其他平台直接调 /user API
async function testCred(cred: Credential) {
  // 有当前项目 remote 时优先走 ls-remote（token 有 repo 权限即可，无需 user 读权限）
  const defaultUrl = await fetchDefaultRemoteUrl()
  if (defaultUrl) {
    await doTest(cred.id, defaultUrl)
    return
  }
  // 无当前项目 remote：generic/未识别平台弹窗手填；其他平台直接调 /user API
  if (!cred.platform || cred.platform === 'generic') {
    testTargetCred.value = cred
    testRepoUrl.value = ''
    showTestRepo.value = true
    return
  }
  await doTest(cred.id)
}

// 取当前项目的默认 remote URL（origin 优先，否则第一个），无项目/无 remote 返回空串
async function fetchDefaultRemoteUrl(): Promise<string> {
  const pid = projectStore.currentProjectId
  if (!pid) return ''
  try {
    const res: any = await remoteApi.list(pid)
    const remotes: { name: string; url: string }[] = res?.data ?? []
    const origin = remotes.find((r) => r.name === 'origin')
    return origin?.url || remotes[0]?.url || ''
  } catch {
    return ''
  }
}

// 执行测试请求（repoUrl 仅 generic 平台用，走 ls-remote）
// response 拦截器已 unwrap 返回 body，沿用项目惯例 `const res: any` 取 unwrap 后的 TestCredentialResp
async function doTest(id: string, repoUrl?: string) {
  testing.value = true
  try {
    const res: any = await credentialApi.test(id, repoUrl)
    const status: TestCredentialResp['status'] = res?.status ?? 'network_error'
    if (status === 'ok') {
      message.success(t('credential.testOk'))
    } else if (status === 'limited') {
      // token 有效但权限受限（如缺 user 读权限），用 warning 提示，区别于完全有效
      message.warning(t('credential.testLimited'))
    } else if (status === 'expired') {
      message.error(t('credential.testExpired'))
      await fetchCreds() // 重新拉取以反映 expired 状态
    } else {
      // network_error：常见网络错误（连接拒绝/超时等）映射为本地化可行动
      // 提示，未知原因保留后端详情便于诊断
      message.error(friendlyRemoteError(res?.message || '', t) || t('credential.lastError.network'))
    }
  } catch (e: any) {
    message.error(e?.userMessage || e?.message)
  } finally {
    testing.value = false
  }
}

// generic 测试弹窗确认：用填入的仓库 URL 走 ls-remote
async function confirmTestRepo() {
  if (!testTargetCred.value || !testRepoUrl.value.trim()) {
    message.warning(t('settings.security.credentials.requiredFields'))
    return
  }
  const id = testTargetCred.value.id
  const url = testRepoUrl.value.trim()
  showTestRepo.value = false
  await doTest(id, url)
}

// 启动 OAuth Device Flow（新建凭据）
function startOAuth(platform: 'github' | 'gitea') {
  oauthDialog.value = {
    show: true,
    platform,
    host: platform === 'github' ? 'github.com' : 'gitea.com',
  }
}

// 重新授权（点击 expired 凭据的「重新授权」按钮）
function retryOAuth(cred: Credential) {
  oauthDialog.value = {
    show: true,
    platform: (cred.platform || 'github') as 'github' | 'gitea',
    host: cred.host,
  }
}

// OAuth 成功回调（Device Flow 弹窗 emit）
async function onOAuthSuccess(_credentialId: string) {
  oauthDialog.value.show = false
  message.success(t('credential.oauth.success'))
  await fetchCreds()
}

// 平台 tag 颜色：github=info / gitlab=success / 其他=default
function platformTagType(p: string): 'default' | 'info' | 'success' {
  switch (p) {
    case 'github': return 'info'
    case 'gitlab': return 'success'
    default: return 'default'
  }
}

// 认证类型 tag 颜色：oauth*=info / basic=default
function authTypeTagType(at: string): 'default' | 'info' {
  return at.startsWith('oauth') ? 'info' : 'default'
}

// 时间格式化：RFC3339 → 本地可读字符串
function formatDate(s: string | null | undefined): string {
  if (!s) return ''
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleString()
}

// 判断是否为 Go time.Time 零值（0001-01-01，前端 new Date 后年份为 1）
// basic cred 的 ExpiresAt 零值表示无固定有效期，LastUsedAt 零值表示从未使用
function isZeroTime(s: string | null | undefined): boolean {
  if (!s) return true
  const d = new Date(s)
  return isNaN(d.getTime()) || d.getFullYear() <= 1
}
</script>

<template>
  <div class="credential-list">
    <div class="header">
      <h3>{{ t('settings.security.credentials.title') }}</h3>
      <NSpace>
        <NButton
          size="small"
          @click="showAddPAT = true"
        >
          {{ t('settings.security.credentials.addPAT') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          @click="startOAuth('github')"
        >
          GitHub OAuth
        </NButton>
        <NButton
          size="small"
          type="primary"
          @click="startOAuth('gitea')"
        >
          Gitea OAuth
        </NButton>
      </NSpace>
    </div>

    <NList
      v-if="creds.length > 0"
      bordered
    >
      <NListItem
        v-for="cred in creds"
        :key="cred.id"
      >
        <NThing>
          <template #header>
            <span>{{ cred.host }}</span>
            <NTag
              v-if="cred.platform"
              size="small"
              :type="platformTagType(cred.platform)"
              style="margin-left: 8px"
            >
              {{ t(`credential.platform.${cred.platform === '' ? 'generic' : cred.platform}`) }}
            </NTag>
            <NTag
              size="small"
              :type="authTypeTagType(cred.auth_type)"
              style="margin-left: 8px"
            >
              {{ cred.auth_type }}
            </NTag>
            <NTag
              v-if="cred.status === 'expired'"
              size="small"
              type="error"
              style="margin-left: 8px"
            >
              {{ t('credential.expired') }}
            </NTag>
          </template>
          <template #description>
            <NSpace size="small">
              <span>{{ cred.username }}</span>
              <span>
                {{ t('credential.expiresAt') }}: {{ isZeroTime(cred.expires_at) ? t('credential.neverExpires') : formatDate(cred.expires_at) }}
              </span>
              <span
                v-if="cred.status === 'expired' && cred.last_error"
                class="cred-error"
              >
                {{ cred.last_error }}
              </span>
              <span v-if="!isZeroTime(cred.last_used_at)">
                {{ t('credential.lastUsed') }}: {{ formatDate(cred.last_used_at) }}
              </span>
            </NSpace>
          </template>
          <template #action>
            <NSpace size="small">
              <NButton
                size="tiny"
                quaternary
                @click="testCred(cred)"
              >
                {{ t('credential.test') }}
              </NButton>
              <NButton
                v-if="cred.status === 'expired'"
                size="tiny"
                type="warning"
                @click="retryOAuth(cred)"
              >
                {{ t('credential.oauth.retry') }}
              </NButton>
              <NButton
                size="tiny"
                quaternary
                type="error"
                @click="deleteCred(cred)"
              >
                {{ t('common.delete') }}
              </NButton>
            </NSpace>
          </template>
        </NThing>
      </NListItem>
    </NList>
    <NEmpty
      v-else
      :description="t('settings.security.credentials.empty')"
    />

    <!-- 添加 PAT 弹窗：host / username / secret 三段式表单 -->
    <NModal
      v-model:show="showAddPAT"
      preset="card"
      style="width: var(--modal-w-sm); max-width: 94vw"
    >
      <template #header>
        {{ t('settings.security.credentials.addPAT') }}
      </template>
      <NForm>
        <NFormItem :label="t('settings.security.credentials.platform')">
          <NSelect
            v-model:value="newCred.platform"
            :options="platformOptions"
          />
          <template #feedback>
            <span style="font-size: 12px">{{ t('settings.security.credentials.platformHint') }}</span>
          </template>
        </NFormItem>
        <NFormItem :label="t('settings.security.credentials.host')">
          <NInput
            v-model:value="newCred.host"
            placeholder="github.com"
          />
        </NFormItem>
        <NFormItem :label="t('settings.security.credentials.username')">
          <NInput v-model:value="newCred.username" />
        </NFormItem>
        <NFormItem :label="t('settings.security.credentials.secret')">
          <NInput
            v-model:value="newCred.secret"
            type="password"
            show-password-on="click"
          />
        </NFormItem>
      </NForm>
      <template #action>
        <NSpace justify="end">
          <NButton @click="showAddPAT = false">
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            type="primary"
            :loading="saving"
            @click="saveCred"
          >
            {{ t('common.save') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- generic 平台测试弹窗：ls-remote 需要仓库 URL -->
    <NModal
      v-model:show="showTestRepo"
      preset="card"
      style="width: var(--modal-w-sm); max-width: 94vw"
    >
      <template #header>
        {{ t('credential.testRepoTitle') }}
      </template>
      <div style="display: flex; flex-direction: column; gap: 8px">
        <NInput
          v-model:value="testRepoUrl"
          :placeholder="t('credential.testRepoPlaceholder')"
        />
        <div style="font-size: 12px; color: var(--text-muted)">
          {{ t('credential.testRepoHint') }}
        </div>
      </div>
      <template #action>
        <NSpace justify="end">
          <NButton @click="showTestRepo = false">
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            type="primary"
            :loading="testing"
            @click="confirmTestRepo"
          >
            {{ t('credential.testRepoConfirm') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- OAuth Device Flow 登录弹窗（Task 6 完整实现） -->
    <OAuthDeviceFlowDialog
      v-model:show="oauthDialog.show"
      :platform="oauthDialog.platform"
      :host="oauthDialog.host"
      @success="onOAuthSuccess"
    />
  </div>
</template>

<style scoped>
.credential-list {
  margin-bottom: 24px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  /* 标题 + 三按钮（添加 PAT / GitHub OAuth / Gitea OAuth）在弹窗内容宽度下
     放不下一行，禁止换行会把按钮裁切在边缘外 */
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.header h3 {
  margin: 0;
}

.cred-error {
  color: var(--error-color);
}
</style>
