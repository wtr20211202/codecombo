<script setup lang="ts">
/**
 * 自定义敏感模式管理（设置 → 安全 → 敏感模式，P-20261006-11）：
 * 用户正则表达的项目自有 secret 形态清单，经 PUT /settings 的
 * customSensitivePatterns 字段整体替换保存——Go 侧（命令历史跳过/审计脱敏/
 * 快照遮蔽）与 TS 侧（sensitiveMask 遮蔽链）各自编译同一列表生效。
 * 编辑形态：行内输入框增删改 + 脏标记一次保存（ApprovalRulesSettings 同款
 * 暂存-保存纪律）；正则合法性服务端编译校验为事实源（400 带下标定位），
 * 前端只做镜像预检（非空/长度/条数/方言禁内联旗标环视）给即时反馈。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { NButton, NEmpty, NInput, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { settingsApi } from '../../api/client'
import { refreshCustomSensitivePatterns } from '../../composables/useCustomSensitivePatterns'

const props = defineProps<{ show: boolean }>()
const { t } = useI18n()
const message = useMessage()

// 与服务端 config.MaxCustomSensitivePatterns / CustomSensitivePatternMaxLen
// 同口径的前端护栏（服务端仍是事实源）
const MAX_PATTERNS = 32
const PATTERN_MAX_LEN = 256

const patterns = ref<string[]>([])
const savedPatterns = ref<string[]>([])
const saving = ref(false)
const draft = ref('')

/** 未保存变更标记：本地编辑与已保存快照不一致（保存按钮/提示条唯一出口） */
const dirty = computed(() => JSON.stringify(patterns.value) !== JSON.stringify(savedPatterns.value))
const atCap = computed(() => patterns.value.length >= MAX_PATTERNS)

async function load() {
  try {
    const res: any = await settingsApi.get()
    const list: string[] = Array.isArray(res?.data?.customSensitivePatterns) ? res.data.customSensitivePatterns : []
    patterns.value = [...list]
    savedPatterns.value = [...list]
  } catch { /* 拦截器统一处理 */ }
}

// 首次进页签即加载：宿主 pane display-directive="show"（ApprovalRulesSettings
// 同款——只靠 watch 存量列表首开永远空白）
onMounted(() => {
  if (props.show) void load()
})
watch(() => props.show, (val) => {
  if (val) void load()
})

/** 客户端镜像预检（服务端写入口仍是事实源）：非空 + 长度 + 方言——内联旗标/
 *  命名组/环视 Go 与 JS 双端语义不同，服务端会拒，这里先行提示 */
function validatePattern(p: string): string | null {
  if (!p) return t('settings.security.sensitivePatterns.emptyEntry')
  if (p.length > PATTERN_MAX_LEN) return t('settings.security.sensitivePatterns.tooLong', { n: PATTERN_MAX_LEN })
  const idx = p.indexOf('(?')
  if (idx >= 0 && p.slice(idx, idx + 3) !== '(?:') return t('settings.security.sensitivePatterns.dialect')
  return null
}

function addDraft() {
  const p = draft.value.trim()
  const err = validatePattern(p)
  if (err) {
    message.warning(err)
    return
  }
  if (patterns.value.includes(p)) {
    message.warning(t('settings.security.sensitivePatterns.duplicate'))
    return
  }
  patterns.value.push(p)
  draft.value = ''
}

function removeRow(index: number) {
  patterns.value.splice(index, 1)
}

function discard() {
  patterns.value = [...savedPatterns.value]
}

async function saveAll() {
  saving.value = true
  try {
    await settingsApi.update({ customSensitivePatterns: patterns.value })
    savedPatterns.value = [...patterns.value]
    message.success(t('settings.security.sensitivePatterns.saved'))
    // 遮蔽链模块态就地刷新（不等 settings.changed 广播往返）
    void refreshCustomSensitivePatterns()
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('settings.security.sensitivePatterns.saveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    class="spls"
    data-testid="sensitive-patterns-manager"
  >
    <div class="spls-head">
      <h4 class="spls-title">
        {{ t('settings.security.sensitivePatterns.title') }}
      </h4>
      <span style="flex: 1" />
      <span class="spls-count">{{ patterns.length }}/{{ MAX_PATTERNS }}</span>
    </div>
    <p class="spls-desc">
      {{ t('settings.security.sensitivePatterns.desc') }}
    </p>
    <p class="spls-hint">
      {{ t('settings.security.sensitivePatterns.dialectHint') }}
    </p>

    <div
      v-if="patterns.length > 0"
      class="spls-list"
      data-testid="sensitive-patterns-list"
    >
      <div
        v-for="(p, i) in patterns"
        :key="`${p}-${i}`"
        class="spls-row"
        data-testid="sensitive-patterns-item"
      >
        <code
          class="spls-pattern"
          :title="p"
        >{{ p }}</code>
        <span style="flex: 1" />
        <NButton
          size="tiny"
          quaternary
          type="error"
          data-testid="sensitive-patterns-delete"
          @click="removeRow(i)"
        >
          {{ t('settings.security.sensitivePatterns.delete') }}
        </NButton>
      </div>
    </div>
    <NEmpty
      v-else
      size="small"
      :description="t('settings.security.sensitivePatterns.empty')"
    />

    <!-- 新增行：输入 + 添加（条数达上限收口，输入保留可改） -->
    <div class="spls-add">
      <NInput
        v-model:value="draft"
        size="small"
        :placeholder="t('settings.security.sensitivePatterns.addPlaceholder')"
        :disabled="atCap"
        :maxlength="PATTERN_MAX_LEN"
        data-testid="sensitive-patterns-input"
        @keyup.enter="addDraft"
      />
      <NTooltip
        v-if="atCap"
        trigger="hover"
      >
        <template #trigger>
          <NButton
            size="small"
            :disabled="atCap"
            data-testid="sensitive-patterns-add"
            @click="addDraft"
          >
            {{ t('settings.security.sensitivePatterns.add') }}
          </NButton>
        </template>
        {{ t('settings.security.sensitivePatterns.cap', { n: MAX_PATTERNS }) }}
      </NTooltip>
      <NButton
        v-else
        size="small"
        :disabled="!draft.trim()"
        data-testid="sensitive-patterns-add"
        @click="addDraft"
      >
        {{ t('settings.security.sensitivePatterns.add') }}
      </NButton>
    </div>

    <!-- 暂存提示 + 保存/放弃：整体替换语义的显式生效点 -->
    <div
      v-if="dirty"
      class="spls-dirty"
      data-testid="sensitive-patterns-dirty"
    >
      <span>{{ t('settings.security.sensitivePatterns.dirty') }}</span>
      <span style="flex: 1" />
      <NButton
        size="tiny"
        quaternary
        @click="discard"
      >
        {{ t('settings.security.sensitivePatterns.discard') }}
      </NButton>
      <NButton
        size="tiny"
        type="primary"
        :loading="saving"
        data-testid="sensitive-patterns-save"
        @click="saveAll"
      >
        {{ t('settings.security.sensitivePatterns.save') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped src="./security-settings.css"></style>

<style scoped>
.spls {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.spls-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.spls-title {
  margin: 0;
  font-size: 13px;
  font-weight: var(--fw-semibold);
}

.spls-count {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.spls-desc {
  margin: 0;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-secondary);
  line-height: 1.6;
}

.spls-hint {
  margin: 0;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-muted);
  line-height: 1.6;
}

.spls-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  max-height: 240px;
  overflow-y: auto;
}

.spls-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
}

.spls-row:last-child {
  border-bottom: none;
}

.spls-pattern {
  font-family: var(--font-mono);
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-primary);
  word-break: break-all;
}

.spls-add {
  display: flex;
  gap: 6px;
}

.spls-dirty {
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
</style>
