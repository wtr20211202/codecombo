<script setup lang="ts">
/**
 * 哨兵规则试跑测试框（P-20261004-20 本地近似档 + P-20261004-107 服务端精确档）：
 * 编辑弹窗内的「测试」折叠区——贴一段样例终端输出，双档试命中：
 *   ①本地 JS RegExp 逐行即时试跑（击键级反馈）；②「服务端真跑」按钮把样例喂进
 * 与生产完全相同的滑窗引擎（POST /api/sentinels/test），RE2 精确语义逐规则返回
 * 命中——本地 JS 是 RE2 的超集、逐行与滑窗口径有别，RE2 专属语法本地只能提示
 * 不可验，精确档恰补此盲区（所见即所产）。
 * 只读消费当前编辑中的 pattern（prop 单向下发），规则不落库不触发通知；不触碰
 * SentinelSettings 的 CRUD / 校验链。
 */
import { ref, computed, watch } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { sentinelApi } from '../../api/domains/sentinel'

const props = defineProps<{ pattern: string }>()
const { t } = useI18n()

const open = ref(false)
const sample = ref('')

/** 试跑行数上限：防超长粘贴无界逐行计算；热路径为 pattern/样例每次击键重算，
 * 500 行 × 512 字符模式量级毫秒级，computed 足够。服务端钳制同值（双档同口径） */
const MAX_LINES = 500

/** RE2→JS 试跑编译：剥离 (?i) 前缀映射为 JS i 旗标——模式占位符示例即 (?i)
 * 惯用形，直接 new RegExp 会抛错；其余 RE2 专属语法（命名捕获组等）JS 不识别
 * → null = 无法本地试跑，如实告知而不是静默给全不命中（服务端真跑档不受此限） */
const testRegex = computed<RegExp | null>(() => {
  let src = props.pattern
  let flags = ''
  if (src.startsWith('(?i)')) {
    src = src.slice(4)
    flags = 'i'
  }
  try {
    return new RegExp(src, flags)
  } catch {
    return null
  }
})

/** JS 编译不了（RE2 专属语法或模式本身有误）→ 本地试跑不可用 */
const jsUnsupported = computed(() => props.pattern.trim() !== '' && testRegex.value === null)

const allLines = computed(() => sample.value.split('\n'))
const truncated = computed(() => allLines.value.length > MAX_LINES)
const hasSample = computed(() => sample.value.length > 0)

interface TestLine { text: string; hit: boolean }
const results = computed<TestLine[]>(() => {
  const re = testRegex.value
  if (!re) return []
  // 无 g 旗标，re.test 无 lastIndex 状态，逐行幂等
  return allLines.value.slice(0, MAX_LINES).map(text => ({ text, hit: re.test(text) }))
})
const hitCount = computed(() => results.value.filter(r => r.hit).length)

// —— 服务端真跑（精确档）——
const serverTesting = ref(false)
/** 上一次真跑结果（null = 未跑过/已失效）；模式或样例变更即失效——结果只对
 * 提交时刻的「模式+样例」负责，陈旧命中比没有结果更误导 */
interface ServerRun { hit: boolean; matched?: string; error?: string; truncated?: boolean }
const serverResult = ref<ServerRun | null>(null)

watch([() => props.pattern, sample], () => { serverResult.value = null })

/** 服务端真跑：单规则（当前编辑中的 pattern，临时 id）+ 样例全文（钳制在服务端，
 * truncated 回执如实转显）。失败由拦截器统一 toast（非静默请求），本地只复位按钮态 */
async function runOnServer() {
  if (serverTesting.value || !props.pattern.trim()) return
  serverTesting.value = true
  try {
    const res: any = await sentinelApi.test({
      rules: [{ id: 'editor', pattern: props.pattern }],
      sample: sample.value,
    })
    const r = res?.data?.results?.[0]
    if (r) {
      serverResult.value = {
        hit: !!r.hit,
        matched: r.matched,
        error: r.error,
        truncated: !!res.data?.truncated,
      }
    }
  } catch {
    serverResult.value = null
  } finally {
    serverTesting.value = false
  }
}
</script>

<template>
  <div
    class="stb"
    data-testid="sentinel-test-box"
  >
    <button
      type="button"
      class="stb-toggle"
      data-testid="sentinel-test-toggle"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="stb-chevron">{{ open ? '▾' : '▸' }}</span>
      {{ t('sentinel.test.title') }}
    </button>
    <template v-if="open">
      <p class="stb-semantics">
        {{ t('sentinel.test.semantics') }}
      </p>
      <NInput
        v-model:value="sample"
        type="textarea"
        :rows="4"
        class="stb-sample"
        :placeholder="t('sentinel.test.placeholder')"
        data-testid="sentinel-test-sample"
      />
      <div class="stb-server">
        <NButton
          size="tiny"
          :loading="serverTesting"
          :disabled="!pattern.trim()"
          data-testid="sentinel-test-server-run"
          @click="runOnServer"
        >
          {{ t('sentinel.test.serverRun') }}
        </NButton>
      </div>
      <div
        v-if="serverResult"
        class="stb-server-result"
        data-testid="sentinel-test-server-result"
      >
        <p
          v-if="serverResult.error"
          class="stb-note stb-err"
        >
          {{ t('sentinel.test.serverPatternError', { error: serverResult.error }) }}
        </p>
        <p
          v-else-if="serverResult.hit"
          class="stb-note stb-ok"
        >
          {{ t('sentinel.test.serverHit') }}
        </p>
        <p
          v-else
          class="stb-note stb-count"
        >
          {{ t('sentinel.test.serverNoHit') }}
        </p>
        <p
          v-if="serverResult.hit && serverResult.matched"
          class="stb-line hit stb-matched"
          data-testid="sentinel-test-server-matched"
        >{{ serverResult.matched }}</p>
        <p
          v-if="serverResult.truncated"
          class="stb-note stb-warn"
        >
          {{ t('sentinel.test.serverTruncated', { n: MAX_LINES }) }}
        </p>
      </div>
      <p
        v-if="jsUnsupported"
        class="stb-note stb-warn"
        data-testid="sentinel-test-unsupported"
      >
        {{ t('sentinel.test.jsUnsupported') }}
      </p>
      <template v-else-if="hasSample">
        <p
          class="stb-note stb-count"
          data-testid="sentinel-test-count"
        >
          {{ hitCount > 0
            ? t('sentinel.test.count', { hit: hitCount, total: results.length })
            : t('sentinel.test.noHit') }}
        </p>
        <p
          v-if="truncated"
          class="stb-note stb-warn"
        >
          {{ t('sentinel.test.truncated', { n: MAX_LINES }) }}
        </p>
        <div
          class="stb-lines"
          data-testid="sentinel-test-lines"
        >
          <div
            v-for="(r, i) in results"
            :key="i"
            class="stb-line"
            :class="{ hit: r.hit }"
            data-testid="sentinel-test-line"
          >{{ r.text }}</div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.stb {
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px dashed var(--border-subtle);
}

.stb-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.stb-toggle:hover {
  color: var(--text-primary);
}

.stb-chevron {
  font-size: 10px;
  width: 10px;
}

.stb-semantics {
  margin: 6px 0;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-muted);
  line-height: var(--lh-meta, 1.45);
}

.stb-sample :deep(textarea) {
  font-family: monospace;
}

/* 服务端真跑（精确档）：按钮行 + 结果区（与本地逐行档并列，RE2 专属语法时本地
 * 档不可用而本档照常可验） */
.stb-server {
  margin-top: var(--space-2);
}

.stb-server-result {
  margin-top: var(--space-1);
}

.stb-ok {
  color: var(--accent-green);
}

.stb-err {
  color: var(--accent-red);
  word-break: break-all;
}

.stb-matched {
  margin-top: var(--space-1);
}

.stb-note {
  margin: 6px 0 0;
  font-size: var(--fs-meta-min, 11.5px);
  line-height: var(--lh-meta, 1.45);
}

.stb-count {
  color: var(--text-primary);
}

.stb-warn {
  color: var(--accent-yellow-warm);
}

/* 命中行高亮：主题变量 color-mix，四主题自动适配（热力图卡同款手法） */
.stb-lines {
  margin-top: 6px;
  max-height: 160px;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.stb-line {
  font-family: monospace;
  font-size: var(--fs-meta-min, 11.5px);
  line-height: 1.7;
  padding: 0 6px;
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 1.7em;
  color: var(--text-secondary);
}

.stb-line.hit {
  color: var(--text-primary);
  background: color-mix(in srgb, var(--accent-green) 16%, transparent);
  box-shadow: inset 2px 0 0 var(--accent-green);
}
</style>
