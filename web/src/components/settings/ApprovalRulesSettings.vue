<script setup lang="ts">
/**
 * 审批分类规则管理（设置 → 安全 → 审批规则，P-20261003-35）：
 * per-op 自动裁决的有序规则表 CRUD + 命中测试。规则经 PUT /settings 的
 * agentApprovalRules 字段整体替换保存——有序整体在本地编辑暂存（增删/改/上下移），
 * 点「保存规则」一次生效；命中测试调服务端按「已保存」的规则表评估（含全局
 * allow 短路语义），保存前可先验证行为是否符合预期。
 * 全局模式关系（设置文案同注记）：全局审批模式 = 完全允许时规则不评估。
 */
import { ref, computed, watch, onMounted } from 'vue'
import {
  NButton, NCheckbox, NDatePicker, NEmpty, NForm, NFormItem, NInput, NModal, NSelect, NTag, useMessage,
} from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { approvalRuleApi, settingsApi, type AgentApprovalRule, type ApprovalRuleEffect } from '../../api/client'
import { formatDateTime } from '../../utils/git'
import { pendingRulePrefill, type ApprovalRulePrefill } from '../../composables/useApprovalRuleSuggest'

const props = defineProps<{ show: boolean }>()
const { t } = useI18n()
const message = useMessage()

// 与服务端 config.ApprovalMaxRules 同口径的前端护栏（服务端仍是事实源）
const MAX_RULES = 50

const rules = ref<AgentApprovalRule[]>([])
const savedRules = ref<AgentApprovalRule[]>([])
const saving = ref(false)
const showModal = ref(false)
/** 正在编辑的规则下标（-1 = 新增） */
const editingIndex = ref(-1)
// tempEnabled/tempAt 是 tempUntil 的表单投影（勾选 + 时刻选择器）：
// 不勾选 = 永久规则（存量形态，保存时不带 tempUntil 字段）
const form = ref<{ opPattern: string; pathPattern: string; effect: ApprovalRuleEffect; tempEnabled: boolean; tempAt: number | null }>({
  opPattern: '', pathPattern: '', effect: 'ask', tempEnabled: false, tempAt: null,
})

/** 未保存变更标记：本地编辑与已保存快照不一致（保存按钮/提示条的唯一出口） */
const dirty = computed(() => JSON.stringify(rules.value) !== JSON.stringify(savedRules.value))
const atCap = computed(() => rules.value.length >= MAX_RULES)

const effectOptions = computed(() => [
  { label: t('approval.rules.effectAllow'), value: 'allow' },
  { label: t('approval.rules.effectDeny'), value: 'deny' },
  { label: t('approval.rules.effectAsk'), value: 'ask' },
])

function effectTagType(effect: string): 'success' | 'error' | 'warning' {
  return effect === 'allow' ? 'success' : effect === 'deny' ? 'error' : 'warning'
}

/** 行对象归一（load/saveRow/saveAll 共用）：空路径条件不落键——行 JSON 形态
 *  与服务端 omitempty 出参对齐（load 与暂存快照同构，dirty 深比较不抖动） */
function normalizeRow(r: AgentApprovalRule): AgentApprovalRule {
  const row: AgentApprovalRule = { opPattern: r.opPattern, effect: r.effect }
  const pp = r.pathPattern?.trim()
  if (pp) row.pathPattern = pp
  if (r.tempUntil) row.tempUntil = r.tempUntil
  return row
}

async function load() {
  try {
    const res: any = await settingsApi.get()
    const list: AgentApprovalRule[] = res?.data?.agentApprovalRules ?? []
    rules.value = list.map(normalizeRow)
    savedRules.value = rules.value.map(r => ({ ...r }))
  } catch { /* 拦截器统一处理 */ }
}

// 首次进页签即加载：宿主 pane 是 display-directive="show"（首次激活时组件
// 带着 show=true 挂载，watch 不回放初始值）——只有 watch 的话存量规则列表
// 首开永远空白（P-243 e2e 实测抓获的 P-35 潜伏缺陷），与宿主 SecuritySettings
// 的 onMounted+watch 双入口同款
onMounted(() => {
  if (!props.show) return
  void load()
  // 审批模式建议「创建规则」深链（P-20261006-28）的表单半程：深链打开弹窗
  // 时预填请求已在途，本组件随审批规则页签首次激活挂载，onMounted 兜消费
  consumePrefillIfPending()
})
watch(() => props.show, (val) => {
  if (val) void load()
})
// 弹窗已开在审批规则页签时收到新预填请求（理论不可达——建议条被弹窗遮罩
// 挡住；防御保留，watch 兜消费）
watch(pendingRulePrefill, (p) => {
  if (props.show && p) consumePrefill(p)
})

/** 消费预填请求：开新增弹窗并预填 op 前缀 + 允许（P-20261006-28 建议升格
 *  的落点）——只预填不落库，粒度（含路径条件/改 ask/deny）由用户确认后自行
 *  保存；消费即清 ref 防重复响应。顺带重拉规则列表，让「已有规则覆盖」的
 *  判定基座与保存动作后的列表都取服务端现值 */
function consumePrefill(p: ApprovalRulePrefill): void {
  pendingRulePrefill.value = null
  void load()
  editingIndex.value = -1
  form.value = { opPattern: p.opPattern, pathPattern: '', effect: p.effect, tempEnabled: false, tempAt: null }
  showModal.value = true
}

function consumePrefillIfPending(): void {
  const p = pendingRulePrefill.value
  if (props.show && p) consumePrefill(p)
}

function openAdd() {
  editingIndex.value = -1
  form.value = { opPattern: '', pathPattern: '', effect: 'ask', tempEnabled: false, tempAt: null }
  showModal.value = true
}

function edit(index: number) {
  const item = rules.value[index]
  if (!item) return
  editingIndex.value = index
  const ts = item.tempUntil ? new Date(item.tempUntil).getTime() : NaN
  form.value = {
    opPattern: item.opPattern,
    pathPattern: item.pathPattern || '',
    effect: (item.effect as ApprovalRuleEffect) || 'ask',
    tempEnabled: !!item.tempUntil,
    tempAt: Number.isFinite(ts) ? ts : null,
  }
  showModal.value = true
}

/** 客户端预检（服务端写入口仍是事实源）：非空 + 128 上限，与服务端 op/path
 *  同宽（ApprovalOpMax/ApprovalPathMax） */
function validate(): string | null {
  const pattern = form.value.opPattern.trim()
  if (!pattern) return t('approval.rules.patternRequired')
  if (pattern.length > 128) return t('approval.rules.patternTooLong')
  if (form.value.pathPattern.trim().length > 128) return t('approval.rules.pathTooLong')
  return null
}

function saveRow() {
  const err = validate()
  if (err) {
    message.warning(err)
    return
  }
  // 临时窗口勾选了却没选时刻：拦截在本地（服务端对缺省字段按永久规则收下，
  // 与意图不符——显式提醒比静默降级可预期）
  if (form.value.tempEnabled && form.value.effect !== 'ask' && !form.value.tempAt) {
    message.warning(t('approval.rules.tempTimeRequired'))
    return
  }
  const row: AgentApprovalRule = { opPattern: form.value.opPattern.trim(), effect: form.value.effect }
  // 路径条件（P-20261004-67）：trim 后空串不落键（= 不限路径，存量形态）
  const pp = form.value.pathPattern.trim()
  if (pp) row.pathPattern = pp
  // 临时启用至（P-20261003-243）：仅对 allow/deny 有意义（ask 本就是中性态），
  // 换成 ask 保存时丢弃窗口字段；时刻转 ISO 串（UTC，服务端 RFC3339 解析）
  if (form.value.tempEnabled && form.value.effect !== 'ask' && form.value.tempAt) {
    row.tempUntil = new Date(form.value.tempAt).toISOString()
  }
  if (editingIndex.value >= 0) {
    rules.value[editingIndex.value] = normalizeRow(row)
  } else {
    rules.value.push(normalizeRow(row))
  }
  showModal.value = false
}

/** 临时窗口过期态（恢复巡检 ≤10min 兜底物化，物化后行内不再有窗口字段） */
function isTempExpired(item: AgentApprovalRule): boolean {
  return !!item.tempUntil && new Date(item.tempUntil).getTime() <= Date.now()
}

/** 日期选择禁选昨天及更早（时刻仍可选今天任意时间——e2e/紧急短窗口要的就是小时级粒度） */
function tempDateDisabled(ts: number): boolean {
  const d = new Date(ts)
  const today = new Date()
  d.setHours(0, 0, 0, 0)
  today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}

function removeRow(index: number) {
  rules.value.splice(index, 1)
}

/** 上下移调优先序（有序列表首个命中生效——更靠前 = 优先级更高） */
function move(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= rules.value.length) return
  const row = rules.value[index]
  if (!row) return
  rules.value.splice(index, 1)
  rules.value.splice(target, 0, row)
}

async function saveAll() {
  saving.value = true
  try {
    await settingsApi.update({ agentApprovalRules: rules.value })
    savedRules.value = rules.value.map(normalizeRow)
    message.success(t('approval.rules.saved'))
  } catch (e: any) {
    message.error(e?.userMessage || t('approval.rules.saveFailed'))
  } finally {
    saving.value = false
  }
}

/** 放弃本地编辑回到已保存快照（失败可恢复） */
function discard() {
  rules.value = savedRules.value.map(r => ({ ...r }))
}

// === 命中测试（按已保存规则表评估，未保存编辑不参与——服务端单一事实源） ===
const testOp = ref('')
const testTarget = ref('')
const testing = ref(false)
const testResult = ref<{ effect: ApprovalRuleEffect; ruleHit: string } | null>(null)

async function runTest() {
  const op = testOp.value.trim()
  if (!op) return
  testing.value = true
  try {
    // 路径样例（P-20261004-67）：可选——带路径条件的规则须双样例同时命中才回命中
    const res: any = await approvalRuleApi.test(op, testTarget.value.trim())
    testResult.value = res?.data ?? null
  } catch { /* 拦截器统一处理 */ } finally {
    testing.value = false
  }
}
</script>

<template>
  <div
    class="arls"
    data-testid="approval-rules-manager"
  >
    <div class="arls-head">
      <h4 class="arls-title">
        {{ t('approval.rules.title') }}
      </h4>
      <span style="flex: 1" />
      <NButton
        size="tiny"
        :disabled="atCap"
        data-testid="approval-rules-add"
        @click="openAdd"
      >
        {{ t('approval.rules.add') }}
      </NButton>
    </div>
    <p class="arls-desc">
      {{ t('approval.rules.desc') }}
    </p>
    <p
      v-if="atCap"
      class="arls-cap"
    >
      {{ t('approval.rules.capReached', { n: MAX_RULES }) }}
    </p>

    <div
      v-if="rules.length > 0"
      class="arls-list"
      data-testid="approval-rules-list"
    >
      <div
        v-for="(item, i) in rules"
        :key="`${item.opPattern}-${i}`"
        class="arls-row"
        data-testid="approval-rules-item"
      >
        <span class="arls-order">{{ i + 1 }}</span>
        <code
          class="arls-pattern"
          :title="item.opPattern"
        >{{ item.opPattern }}</code>
        <!-- 路径条件（P-20261004-67）：有则展示，行内即可辨 op×path 双条件规则 -->
        <code
          v-if="item.pathPattern"
          class="arls-path"
          data-testid="approval-rules-item-path"
          :title="item.pathPattern"
        >{{ item.pathPattern }}</code>
        <NTag
          size="tiny"
          :type="effectTagType(item.effect)"
          class="arls-effect"
        >
          {{ t(`approval.rules.effectLabel.${item.effect || 'ask'}`) }}
        </NTag>
        <!-- 临时窗口徽标（P-20261003-243）：到期未物化（巡检 ≤10min 兜底）显已结束弱化态 -->
        <NTag
          v-if="item.tempUntil"
          size="tiny"
          :type="isTempExpired(item) ? 'default' : 'warning'"
          class="arls-temp"
          :data-testid="isTempExpired(item) ? 'approval-rules-temp-expired' : 'approval-rules-temp-tag'"
          :title="item.tempUntil"
        >
          {{ isTempExpired(item) ? t('approval.rules.tempExpired') : t('approval.rules.tempUntilTag', { time: formatDateTime(item.tempUntil) }) }}
        </NTag>
        <span style="flex: 1" />
        <span class="arls-actions">
          <NButton
            size="tiny"
            quaternary
            :disabled="i === 0"
            :title="t('approval.rules.moveUp')"
            @click="move(i, -1)"
          >
            ↑
          </NButton>
          <NButton
            size="tiny"
            quaternary
            :disabled="i === rules.length - 1"
            :title="t('approval.rules.moveDown')"
            @click="move(i, 1)"
          >
            ↓
          </NButton>
          <NButton
            size="tiny"
            quaternary
            @click="edit(i)"
          >
            {{ t('approval.rules.edit') }}
          </NButton>
          <NButton
            size="tiny"
            quaternary
            type="error"
            data-testid="approval-rules-delete"
            @click="removeRow(i)"
          >
            {{ t('approval.rules.delete') }}
          </NButton>
        </span>
      </div>
    </div>
    <NEmpty
      v-else
      size="small"
      :description="t('approval.rules.empty')"
    />

    <!-- 暂存提示 + 保存/放弃：整体替换语义的显式生效点 -->
    <div
      v-if="dirty"
      class="arls-dirty"
      data-testid="approval-rules-dirty"
    >
      <span>{{ t('approval.rules.dirty') }}</span>
      <span style="flex: 1" />
      <NButton
        size="tiny"
        quaternary
        @click="discard"
      >
        {{ t('approval.rules.discard') }}
      </NButton>
      <NButton
        size="tiny"
        type="primary"
        :loading="saving"
        data-testid="approval-rules-save"
        @click="saveAll"
      >
        {{ t('approval.rules.save') }}
      </NButton>
    </div>

    <!-- 命中测试：输入 op 样例（+可选路径样例）看命中哪条（按已保存规则表评估） -->
    <div class="arls-test">
      <h4 class="arls-test-title">
        {{ t('approval.rules.testTitle') }}
      </h4>
      <div class="arls-test-row">
        <NInput
          v-model:value="testOp"
          size="small"
          :placeholder="t('approval.rules.testPlaceholder')"
          data-testid="approval-rules-test-input"
          @keyup.enter="runTest"
        />
        <NInput
          v-model:value="testTarget"
          size="small"
          :placeholder="t('approval.rules.testPathPlaceholder')"
          data-testid="approval-rules-test-path-input"
          @keyup.enter="runTest"
        />
        <NButton
          size="small"
          :loading="testing"
          :disabled="!testOp.trim()"
          data-testid="approval-rules-test-btn"
          @click="runTest"
        >
          {{ t('approval.rules.testBtn') }}
        </NButton>
      </div>
      <p
        v-if="testResult"
        class="arls-test-result"
        data-testid="approval-rules-test-result"
      >
        <template v-if="testResult.ruleHit">
          {{ t('approval.rules.testHit', { pattern: testResult.ruleHit, effect: t(`approval.rules.effectLabel.${testResult.effect}`) }) }}
        </template>
        <template v-else>
          {{ t('approval.rules.testNoHit') }}
        </template>
      </p>
      <p class="arls-test-note">
        {{ t('approval.rules.testSavedOnly') }}
      </p>
    </div>

    <!-- 新增 / 编辑弹窗：操作前缀 + 裁决动作 -->
    <NModal
      v-model:show="showModal"
      preset="card"
      style="width: var(--modal-w-sm); max-width: 94vw"
    >
      <template #header>
        {{ editingIndex >= 0 ? t('approval.rules.editTitle') : t('approval.rules.addTitle') }}
      </template>
      <NForm label-placement="top">
        <NFormItem :label="t('approval.rules.fieldPattern')">
          <NInput
            v-model:value="form.opPattern"
            :placeholder="t('approval.rules.fieldPatternPlaceholder')"
            :maxlength="128"
            data-testid="approval-rules-form-pattern"
          />
        </NFormItem>
        <!-- 路径条件（P-20261004-67）：可选 glob，与 op 前缀 AND——留空 = 不限路径 -->
        <NFormItem :label="t('approval.rules.fieldPath')">
          <NInput
            v-model:value="form.pathPattern"
            :placeholder="t('approval.rules.fieldPathPlaceholder')"
            :maxlength="128"
            data-testid="approval-rules-form-path"
          />
        </NFormItem>
        <p class="arls-form-hint">
          {{ t('approval.rules.fieldPathHint') }}
        </p>
        <NFormItem :label="t('approval.rules.fieldEffect')">
          <NSelect
            v-model:value="form.effect"
            :options="effectOptions"
            size="small"
            data-testid="approval-rules-form-effect"
          />
        </NFormItem>
        <!-- 临时启用至（P-20261003-243）：部署窗口等短时放行/拦截，到点服务端
             自动恢复为「询问」并入账通知；仅 allow/deny 提供窗口（ask 本就是中性态） -->
        <NFormItem
          v-if="form.effect !== 'ask'"
          :label="t('approval.rules.tempLabel')"
        >
          <div class="arls-temp-form">
            <NCheckbox
              v-model:checked="form.tempEnabled"
              size="small"
              data-testid="approval-rules-form-temp-toggle"
            >
              {{ t('approval.rules.tempToggle') }}
            </NCheckbox>
            <NDatePicker
              v-if="form.tempEnabled"
              v-model:value="form.tempAt"
              type="datetime"
              size="small"
              clearable
              :is-date-disabled="tempDateDisabled"
              :placeholder="t('approval.rules.tempPlaceholder')"
              data-testid="approval-rules-form-temp-at"
            />
            <p class="arls-form-hint">
              {{ t('approval.rules.tempHint') }}
            </p>
          </div>
        </NFormItem>
        <p class="arls-form-hint">
          {{ t('approval.rules.formHint') }}
        </p>
      </NForm>
      <template #action>
        <div class="arls-modal-actions">
          <NButton
            size="small"
            quaternary
            @click="showModal = false"
          >
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            size="small"
            type="primary"
            data-testid="approval-rules-form-save"
            @click="saveRow"
          >
            {{ t('common.save') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped src="./security-settings.css"></style>

<style scoped>
.arls {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.arls-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.arls-title {
  margin: 0;
  font-size: 13px;
  font-weight: var(--fw-semibold);
}

.arls-desc {
  margin: 0;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-secondary);
  line-height: 1.6;
}

.arls-cap {
  margin: 0;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--accent-red);
}

.arls-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  max-height: 280px;
  overflow-y: auto;
}

.arls-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
}

.arls-row:last-child {
  border-bottom: none;
}

.arls-order {
  flex: 0 0 auto;
  min-width: 16px;
  color: var(--text-muted);
  font-size: var(--fs-meta-min, 11.5px);
}

.arls-pattern {
  font-family: var(--font-mono);
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-primary);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 路径条件徽标（P-20261004-67）：弱化于 op 前缀，同族等宽字体可辨 */
.arls-path {
  font-family: var(--font-mono);
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-secondary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.arls-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.arls-effect {
  flex: 0 0 auto;
}

.arls-temp {
  flex: 0 0 auto;
  font-family: var(--font-mono);
}

.arls-temp-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.arls-dirty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--accent-yellow);
  background: var(--bg-warning-alt);
  border-radius: var(--radius-md);
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-primary);
}

.arls-test-title {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: var(--fw-semibold);
}

.arls-test-row {
  display: flex;
  gap: 6px;
}

.arls-test-result {
  margin: 0;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-primary);
}

.arls-test-note {
  margin: 0;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-muted);
}

.arls-form-hint {
  margin: 0;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-secondary);
}

.arls-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
