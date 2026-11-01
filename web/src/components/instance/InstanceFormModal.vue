<script setup lang="ts">
// 添加 / 编辑远程实例统一弹窗（替代旧的"添加 modal + 卡片内联编辑"两套表单）
import { ref, computed, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useInstanceStore, type Instance } from '../../stores/instance'
import { useI18n } from '../../composables/useI18n'
import { instanceApi } from '../../api/domains/system'

const props = defineProps<{
  show: boolean
  /** 传入则为编辑模式，否则为添加模式 */
  editInstance?: Instance | null
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const message = useMessage()
const instanceStore = useInstanceStore()
const { t } = useI18n()

const isEdit = computed(() => !!props.editInstance)

const name = ref('')
const url = ref('')
const token = ref('')
const parentId = ref('')
const submitting = ref(false)
const testing = ref(false)
const testResult = ref<'success' | 'reachable' | 'wrongToken' | 'notapp' | 'fail' | null>(null)

// 打开时按模式填充/清空表单；同时确保实例列表已加载——
// 「所属中心」候选来自实例列表，刚进页面就打开弹窗时列表可能尚未返回，
// 下拉会只剩"无（独立实例）"，看起来像"没有可选的中心"
watch(() => props.show, (v) => {
  if (!v) return
  const inst = props.editInstance
  name.value = inst?.name || ''
  url.value = inst?.url || ''
  token.value = ''
  parentId.value = inst?.parentId || ''
  testResult.value = null
  // 悬空防御：parentId 指向已不存在的实例（正常有级联清理，双保险）时
  // 下拉会显示"无"但 v-model 仍持旧值——保存的值与显示不符。
  // 校验须在列表就绪后做（列表未加载时不误清合法值）
  parentId.value = inst?.parentId || ''
  void instanceStore.ensureInstancesFresh().then(() => {
    if (parentId.value && !instanceStore.instances.some(i => i.id === parentId.value)) {
      parentId.value = ''
    }
  })
})

// loopback 主机名（URL.hostname 对 IPv6 返回无方括号形式，如 '::1'）
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']

// 自引用检测：URL 指向当前服务自身（同源或 loopback 同端口）时拒绝——
// 自引用实例的代理请求会打回本机，切换后必然异常
function isSelfURL(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.host === window.location.host) return true
    return LOOPBACK_HOSTS.includes(u.hostname) && u.port === window.location.port
  } catch {
    return false
  }
}

// 规范化实例 URL：无协议时自动补 https://（TLS 已是产品默认，裸 host:port
// 的真实目标绝大多数是 https；http-only 显式写 http://），统一为 origin 形式
function normalizeInstanceUrl(input: string): string | null {
  try {
    const s = /^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`
    return new URL(s).origin
  } catch {
    return null
  }
}

// 上级实例候选：排除自身及其祖先链（选祖先会形成环，后端
// CheckCycleAdd 会拒绝——下拉里直接不列，避免用户选了才报错）。
// 本机可作为中心：子实例从本机拉取更新（本机实例的 URL 需配置为
// 对外可达地址，Token 需为本机签发的 API Token）
const parentCandidates = computed(() => {
  const banned = new Set<string>()
  let cur = props.editInstance
  while (cur) {
    banned.add(cur.id)
    const nextId = cur.parentId
    cur = nextId ? instanceStore.instances.find(i => i.id === nextId) || null : null
  }
  return instanceStore.instances.filter(i => !banned.has(i.id))
})

// loopback 地址探测：测试连接失败时若地址是 localhost/127.x，提示跨机可达性
function isLoopbackUrl(raw: string): boolean {
  try {
    const s = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(s).hostname)
  } catch {
    return false
  }
}

async function testConnection() {
  if (!url.value) return
  // scl_ 前缀是解锁密码 token，实例连接需要的是 API Token（sc_ 开头）
  if (token.value.startsWith('scl_')) {
    testResult.value = 'wrongToken'
    return
  }
  testing.value = true
  testResult.value = null
  try {
    // 服务端代为探测：此前由浏览器直接 fetch 目标实例，跨源（不同 IP/端口）
    // 必撞 CORS 把可达误判为失败；保存后的健康检查本就走服务端，行为对齐
    //（响应拦截器已解包 response.data，res 直接就是服务端响应体）
    const res: any = await instanceApi.probe({ url: url.value, token: token.value || undefined })
    const status = res?.data?.status
    const httpStatus = res?.data?.httpStatus
    // scheme 自动发现：探测到输入地址之外的可听地址（典型：裸域补 https 后
    // 目标实际在 http，或存量 http 对端已升级 TLS）→ 回填地址并提示
    const suggested: string | undefined = res?.data?.suggestedUrl
    if (suggested) {
      url.value = suggested
    }
    if (res?.data?.tlsHint) {
      // 对端是 https 但证书未受本机信任：给出可行动提示而非笼统的"不可达"
      message.warning(t('instance.tlsUntrusted'))
    }
    if (status === 'online') {
      // 423 锁定 = 服务在跑但 token 无效/未填（目标锁定拦截）
      if (suggested) message.info(t('instance.schemeSwitched'))
      testResult.value = httpStatus === 423 ? 'reachable' : 'success'
    } else if (status === 'invalid') {
      // HTTP 可达但响应不是本应用（如 gitea/nginx）
      testResult.value = 'notapp'
    } else {
      // 网络层失败才是真正离线
      testResult.value = 'fail'
    }
  } catch {
    testResult.value = 'fail'
  } finally {
    testing.value = false
  }
}

async function submit() {
  if (!name.value || !url.value || submitting.value) return
  const normalized = normalizeInstanceUrl(url.value)
  if (!normalized) {
    message.error(t('instance.invalidUrl'))
    return
  }
  // 自引用拦截仅针对远程实例：本机实例的地址天然指向本机服务（编辑本机
  // 就是为了把它配置成对外可达地址供子实例拉取更新）
  if (!props.editInstance?.isLocal && isSelfURL(normalized)) {
    message.error(t('instance.selfRef'))
    return
  }
  submitting.value = true
  try {
    if (isEdit.value && props.editInstance) {
      await instanceStore.updateInstance(props.editInstance.id, {
        name: name.value,
        url: normalized,
        ...(token.value ? { token: token.value } : {}),
        // 空串 = 显式清除上级；null 会被后端 *string 视为"未提供"而不更新
        parentId: parentId.value,
      })
      message.success(t('instance.updated'))
    } else {
      await instanceStore.addInstance({
        name: name.value,
        url: normalized,
        token: token.value || undefined,
        parentId: parentId.value || undefined,
      })
      message.success(t('instance.added', { name: name.value }))
    }
    emit('update:show', false)
  } catch { /* 拦截器处理 */ } finally {
    submitting.value = false
  }
}

function close() {
  emit('update:show', false)
}
</script>

<template>
  <!-- 不允许点击遮罩关闭——表单填写内容易被误操作丢失 -->
  <div
    v-show="props.show"
    class="modal-overlay"
  >
    <div class="modal-card">
      <div class="modal-title">
        {{ isEdit ? t('instance.editTitle') : t('instance.addRemote') }}
      </div>
      <div class="modal-body">
        <div class="modal-field">
          <label>{{ t('instance.name') }}</label>
          <input
            v-model="name"
            class="modal-input"
            :placeholder="t('instance.namePlaceholder')"
          >
        </div>
        <div class="modal-field">
          <label>{{ t('instance.url') }}</label>
          <input
            v-model="url"
            class="modal-input"
            :placeholder="props.editInstance?.isLocal ? t('instance.localUrlPlaceholder') : t('instance.urlPlaceholder')"
          >
        </div>
        <div class="modal-field">
          <label>{{ t('instance.token') }}</label>
          <input
            v-model="token"
            class="modal-input"
            autocomplete="off"
            :placeholder="props.editInstance?.isLocal ? t('instance.localTokenPlaceholder') : (isEdit ? t('instance.newTokenPlaceholder') : t('instance.tokenPlaceholder'))"
          >
        </div>
        <div class="modal-field">
          <label>{{ t('update.parentInstance') }}</label>
          <select
            v-model="parentId"
            class="modal-input"
          >
            <option value="">
              {{ t('update.noParent') }}
            </option>
            <option
              v-for="inst in parentCandidates"
              :key="inst.id"
              :value="inst.id"
            >
              {{ inst.name }}
            </option>
          </select>
        </div>
        <div class="test-row">
          <button
            class="modal-btn"
            :disabled="!url || testing"
            @click="testConnection"
          >
            {{ testing ? t('instance.testing') : t('instance.testConnection') }}
          </button>
          <span
            v-if="testResult === 'success'"
            class="test-hint ok"
          >{{ t('instance.testSuccess') }}</span>
          <span
            v-else-if="testResult === 'reachable'"
            class="test-hint warn"
          >{{ t('instance.testReachable') }}</span>
          <span
            v-else-if="testResult === 'wrongToken'"
            class="test-hint err"
          >{{ t('instance.testWrongToken') }}</span>
          <span
            v-else-if="testResult === 'notapp'"
            class="test-hint err"
          >{{ t('instance.testNotApp') }}</span>
          <span
            v-else-if="testResult === 'fail'"
            class="test-hint err"
          >
            {{ isLoopbackUrl(url) ? t('instance.testLoopbackHint') : t('instance.testFailed') }}
          </span>
        </div>
      </div>
      <div class="modal-footer">
        <button
          class="modal-btn"
          @click="close"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          class="modal-btn primary"
          :disabled="!name || !url || submitting"
          @click="submit"
        >
          {{ isEdit ? t('instance.save') : t('common.add') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0; z-index: 2000;
  background: var(--overlay-mask); display: flex; align-items: center; justify-content: center;
}
.modal-card {
  width: 380px; background: var(--bg-panel); border: 1px solid var(--border-default); border-radius: 8px;
  box-shadow: var(--shadow-pop-lg);
}
.modal-title {
  padding: 12px 16px; font-size: 0.95em; font-weight: 500; color: var(--text-primary);
  border-bottom: 1px solid var(--border-subtle);
}
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.modal-field { display: flex; flex-direction: column; gap: 4px; }
.modal-field label { font-size: 0.85em; color: var(--text-secondary); }
.modal-input {
  background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: 4px;
  padding: 6px 10px; font-size: 13px; outline: none; width: 100%;
}
.modal-input:focus { border-color: var(--accent-blue); }
.test-row { display: flex; align-items: center; gap: 8px; }
.test-hint { font-size: 12px; }
.test-hint.ok { color: var(--accent-green); }
.test-hint.warn { color: var(--accent-yellow-warm); }
.test-hint.err { color: var(--accent-red); }
.modal-footer {
  padding: 10px 16px; display: flex; justify-content: flex-end; gap: 8px;
  border-top: 1px solid var(--border-subtle);
}
.modal-btn {
  padding: 5px 14px; border-radius: 4px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--border-default); background: var(--bg-hover); color: var(--text-primary);
}
.modal-btn:hover { background: var(--bg-active); }
.modal-btn.primary { background: var(--accent-blue); border-color: var(--accent-blue); color: var(--text-on-accent); }
.modal-btn.primary:hover { background: var(--accent-blue-hover); }
.modal-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
