// 统一的对话框工具：用 Naive UI 的 discrete dialog 替代原生 prompt/confirm
// 提供 Promise 风格 API，便于在异步流程中使用
import { h, ref, computed } from 'vue'
import type { Ref, VNodeChild } from 'vue'
import { createDiscreteApi, NButton, NInput, NRadio, NRadioGroup } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import i18n from '../i18n'

interface DiscreteApi {
  dialog: {
    // naive discrete dialog 返回 DialogReactive（自渲染 action 按钮须手动
    // destroy 关闭弹层，save.ts/useBranchCheckout 同款）
    info: (opts: Record<string, unknown>) => { destroy(): void }
    warning: (opts: Record<string, unknown>) => { destroy(): void }
    success: (opts: Record<string, unknown>) => { destroy(): void }
    error: (opts: Record<string, unknown>) => { destroy(): void }
  }
  message: {
    error: (msg: string) => void
    success: (msg: string) => void
    warning: (msg: string) => void
  }
}

let discrete: DiscreteApi | null = null

function getDiscrete() {
  if (discrete) return discrete
  const themeStore = useThemeStore()
  discrete = createDiscreteApi(['dialog', 'message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })
  return discrete
}

/**
 * 显示一个确认对话框，返回用户是否确认
 * 替代 confirm() 调用
 */
export function confirmDialog(options: {
  title?: string
  /** 文案，或渲染函数（列表等富内容，如分享前的敏感文件警示清单） */
  content?: string | (() => VNodeChild)
  type?: 'info' | 'success' | 'warning' | 'error'
  confirmText?: string
  cancelText?: string
}): Promise<boolean> {
  const { dialog } = getDiscrete()
  const t = i18n.global.t
  return new Promise((resolve) => {
    dialog[options.type || 'warning']({
      title: options.title || '',
      content: options.content || '',
      // 显式提供默认按钮文本，避免 Naive UI 在未传 negativeText 时隐藏取消按钮
      positiveText: options.confirmText ?? t('common.confirm'),
      negativeText: options.cancelText ?? t('common.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onMaskClick: () => resolve(false),
      onClose: () => resolve(false),
    })
  })
}

/** promptDialog 可选单选组（P-20261003-119 stash 范围三态等「输入 + 选项」表单）：
 * 值写入调用方自持的 ref——返回值仍只是文本输入，多值收集不破坏既有
 * Promise<string | null> 契约（既有调用方零变化） */
export interface PromptRadioOption {
  label: string
  value: string
  disabled?: boolean
}

export interface PromptRadioGroup {
  value: Ref<string>
  options: PromptRadioOption[]
  /** 选项区下方注记行（如 --staged 版本不足降级说明），空/缺省不渲染 */
  hint?: string
}

/**
 * 显示一个输入对话框，返回用户输入的值（取消时返回 null）
 * 替代 prompt() 调用
 */
export function promptDialog(options: {
  title?: string
  label?: string
  placeholder?: string
  defaultValue?: string
  /** 输入框类型：password 用于口令类输入（打码显示），缺省 text */
  inputType?: 'text' | 'password'
  /** 输入框上方的单选组（见 PromptRadioGroup），缺省不渲染 */
  radio?: PromptRadioGroup
  confirmText?: string
  cancelText?: string
  /** 简单校验：返回错误提示字符串表示不通过 */
  validate?: (v: string) => string | null
  /** 输入过程中的动态提示（P-20261003-101 导出口令强度警示等）：随输入实时
   * 重算，返回 null = 无提示。纯警示不改提交行为——阻断与否仍由 validate 独立把关 */
  liveHint?: (v: string) => { text: string; type?: 'warning' } | null
  /** 输入框下方的静态提示行（P-20261003-263 stash 应用到新分支等「确认前须知」；
   * 与 liveHint 互斥使用，同传时本字段排在动态提示之后）。纯展示不影响提交 */
  hint?: string
}): Promise<string | null> {
  const { dialog } = getDiscrete()
  return new Promise((resolve) => {
    const inputValue = ref(options.defaultValue || '')
    let resolved = false
    const settle = (val: string | null) => {
      if (resolved) return
      resolved = true
      resolve(val)
    }
    dialog.info({
      title: options.title || '',
      content: () => {
        // content 渲染函数读取 inputValue：受控 NInput 链路本就依赖其响应式重渲染，提示行同链路即时增删
        const hint = options.liveHint?.(inputValue.value) || null
        const hintColor = hint?.type === 'warning' ? 'var(--accent-yellow)' : 'var(--text-secondary)'
        return h('div', { style: 'display:flex;flex-direction:column;gap:8px;padding-top:4px;' }, [
          options.label ? h('div', { style: 'font-size:13px;color:var(--text-secondary);' }, options.label) : null,
          options.radio
            ? h(NRadioGroup, {
                value: options.radio.value.value,
                'onUpdate:value': (v: string) => { options.radio!.value.value = v },
                size: 'small',
              }, () => options.radio!.options.map(o =>
                h(NRadio, { key: o.value, value: o.value, disabled: o.disabled }, () => o.label)))
            : null,
          options.radio?.hint
            ? h('div', { style: 'font-size:12px;color:var(--text-secondary);' }, options.radio.hint)
            : null,
          h(NInput, {
            value: inputValue.value,
            'onUpdate:value': (v: string) => { inputValue.value = v },
            placeholder: options.placeholder || '',
            type: options.inputType,
            autofocus: true,
            size: 'small',
          }),
          hint ? h('div', { style: `font-size:12px;color:${hintColor};` }, hint.text) : null,
          options.hint ? h('div', { style: 'font-size:12px;color:var(--text-secondary);' }, options.hint) : null,
        ])
      },
      // 显式提供默认按钮文本，避免 Naive UI 在未传 negativeText 时隐藏取消按钮
      positiveText: options.confirmText ?? i18n.global.t('common.confirm'),
      negativeText: options.cancelText ?? i18n.global.t('common.cancel'),
      onPositiveClick: () => {
        if (options.validate) {
          const err = options.validate(inputValue.value)
          if (err) {
            getDiscrete()!.message.error(err)
            return false
          }
        }
        settle(inputValue.value)
      },
      onNegativeClick: () => settle(null),
      onMaskClick: () => settle(null),
      onClose: () => settle(null),
    })
  })
}

/**
 * 提交信息门禁失败弹层（P-20261003-273）：提交预检未通过规范时弹「失败原因 +
 * 交给智能体修」弹层，三出口——交给智能体修（主钮，新建 agent 会话改写合规
 * 信息）/ 仍要提交（显式旁路，非规范项目的一键豁免）/ 取消（⨉/遮罩/ESC，仅
 * 关弹层回提交框改草稿）。cancel 与 anyway 语义必须分开：误关弹层不得等于
 * 放行提交，故不走 confirmDialog（其一切关闭路径都 resolve(false)）——自渲染
 * 按钮区沿 confirmUploadSameName 三选先例。
 * Promise 永不 reject：任何关闭路径都 resolve，让提交流程单分支收口
 */
export function confirmCommitGateFix(options: {
  title: string
  /** 失败原因行（已由调用方经 i18n 渲染，每条一行） */
  reasons: string[]
  agentText: string
  anywayText: string
  /** 弹层补充说明行（如「改写结果在智能体会话中产出，人工审阅后回填提交框」） */
  hint?: string
}): Promise<'agent' | 'anyway' | 'cancel'> {
  const { dialog } = getDiscrete()
  return new Promise((resolve) => {
    let settled = false
    const settle = (v: 'agent' | 'anyway' | 'cancel') => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const d = dialog.warning({
      title: options.title,
      content: () => h('div', { 'data-testid': 'commit-gate-dialog', style: 'display:flex;flex-direction:column;gap:6px;padding-top:4px;' }, [
        h('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
          options.reasons.map(r => h('div', { key: r }, r))),
        options.hint ? h('div', { style: 'font-size:12px;color:var(--text-secondary);' }, options.hint) : null,
      ]),
      action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;' }, [
        h(NButton, {
          size: 'small',
          'data-testid': 'commit-gate-anyway',
          onClick: () => { d.destroy(); settle('anyway') },
        }, () => options.anywayText),
        h(NButton, {
          size: 'small',
          type: 'primary',
          'data-testid': 'commit-gate-agent',
          onClick: () => { d.destroy(); settle('agent') },
        }, () => options.agentText),
      ]),
      onMaskClick: () => settle('cancel'),
      onClose: () => settle('cancel'),
    })
  })
}

/**
 * 上传同名覆盖确认（P-20261003-230）：拖入/选择器批次命中目标目录同名文件时
 * 弹「N 个同名文件」确认，三出口——跳过（默认安全档）/覆盖（显式意图，warning
 * 档）/取消（⨉/遮罩/ESC，整批不动）。自渲染按钮区（save.ts 保存冲突三选同款
 * 先例）：跳过为常规钮排前、覆盖为 warning 警示钮——着色语义把保守项放显眼位，
 * 键盘 Tab+Enter / 读屏顺序同理先达跳过。
 * Promise 永不 reject：任何关闭路径都 resolve，让上传链路单分支收口
 */
export function confirmUploadSameName(
  names: string[],
  dest: string,
): Promise<'skip' | 'overwrite' | 'cancel'> {
  const { dialog } = getDiscrete()
  const t = i18n.global.t
  // 名单取前 3 项摘要（summarizeNames 同族截断惯例），其余以 … 收口
  let heads = names.slice(0, 3).join(', ')
  if (names.length > 3) heads += '…'
  return new Promise((resolve) => {
    let settled = false
    const settle = (v: 'skip' | 'overwrite' | 'cancel') => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const d = dialog.warning({
      title: t('fileTree.uploadSameNameTitle', { n: names.length }),
      content: () => h('div', { 'data-testid': 'upload-same-name-dialog', style: 'display:flex;flex-direction:column;gap:6px;padding-top:4px;' }, [
        h('div', {}, t('fileTree.uploadSameNameContent', { dir: dest || '/', names: heads })),
        h('div', { style: 'font-size:12px;color:var(--text-secondary);' }, t('fileTree.uploadSameNameHint')),
      ]),
      action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;' }, [
        h(NButton, {
          size: 'small',
          'data-testid': 'upload-same-name-skip',
          onClick: () => { d.destroy(); settle('skip') },
        }, () => t('fileTree.uploadSameNameSkip')),
        h(NButton, {
          size: 'small',
          type: 'warning',
          'data-testid': 'upload-same-name-overwrite',
          onClick: () => { d.destroy(); settle('overwrite') },
        }, () => t('fileTree.uploadSameNameOverwrite')),
      ]),
      onMaskClick: () => settle('cancel'),
      onClose: () => settle('cancel'),
    })
  })
}

/**
 * 回收站恢复同名冲突三选（P-20261006-15）：目标已存在 409 的前进路径——
 * 重命名恢复（恢复为建议名 <name>-restaged.<ext>，一键替代「去目标位置手动
 * 改名/删除再回回收站」的两窗口往返）/ 打开目标位置（去文件树自行处置）/
 * 取消。重命名不覆盖任何现有文件，「不覆盖」安全语义不变；引用断裂（旧路径
 * 上的链接/导入不跟随新名）文案如实注明，用户自担。自渲染按钮区沿
 * confirmUploadSameName 三选先例，重命名为 primary 主出口。Promise 永不 reject
 */
export function confirmTrashRestoreConflict(options: {
  name: string
  /** 建议名（utils/restageName 首建议；建议名再冲突由执行链步进，此处只展示） */
  suggested: string
}): Promise<'rename' | 'locate' | 'cancel'> {
  const { dialog } = getDiscrete()
  const t = i18n.global.t
  return new Promise((resolve) => {
    let settled = false
    const settle = (v: 'rename' | 'locate' | 'cancel') => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const d = dialog.warning({
      title: t('files.trash.conflictTitle'),
      content: () => h('div', { 'data-testid': 'trash-conflict-dialog', style: 'display:flex;flex-direction:column;gap:6px;padding-top:4px;' }, [
        h('div', {}, t('files.trash.conflictContent', { name: options.name })),
        h('div', { style: 'font-size:12px;color:var(--accent-orange);' }, t('files.trash.conflictRenameHint')),
      ]),
      action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;' }, [
        h(NButton, {
          size: 'small',
          type: 'primary',
          'data-testid': 'trash-conflict-rename',
          onClick: () => { d.destroy(); settle('rename') },
        }, () => t('files.trash.conflictRename', { name: options.suggested })),
        h(NButton, {
          size: 'small',
          'data-testid': 'trash-conflict-locate',
          onClick: () => { d.destroy(); settle('locate') },
        }, () => t('files.trash.conflictLocate')),
      ]),
      onMaskClick: () => settle('cancel'),
      onClose: () => settle('cancel'),
    })
  })
}
