#!/usr/bin/env node
// check-keybindings.mjs —— 键位注册静态审计：冲突检测 + ShortcutsHelp 文档对账（P-20261003-32）
//
// 用法：
//   node scripts/check-keybindings.mjs                # 审计 src 键位注册，冲突/漂移退出码 1
//   node scripts/check-keybindings.mjs --src <dir>    # 审计指定源码目录（构造冲突/漂移样例自测用）
//
// 动机：键位注册散落多处，新增键的冲突核查与帮助对账全靠人工 grep（每条键盘提案
// 重复支付的流水线税）。本脚本按仓内已知注册模式静态提取键位清单，输出
// 「键位→作用域→注册点」表并做三类判定。
//
// 审计面（提取依赖仓内注册惯例——注册方式重构时须同步本脚本正则，失明有最低数量守卫）：
//   global   = stores/keymap.ts KEYMAP_ACTIONS 默认表 domain:'global' 条目（P-20261002-28
//              起 useLayoutKeyboard 不再硬编码布局键，动作→combo 查此表）+ stores/lock.ts
//              锁定默认键（平台互斥双默认，mac=meta / win=ctrl 归并同形，标 variant 不算冲突）
//              + useLayoutKeyboard.ts 硬编码单键/区间键（Esc 逐层收起、? 备忘单、
//              Alt+↑↓ diff 导航、Ctrl+1-9 数字直达 capture、Ctrl+Alt+1-9 工作区
//              预设直达 P-20261004-49——keymap MVP 范围外维持硬编码）
//   terminal = stores/keymap.ts KEYMAP_ACTIONS domain:'terminal' 条目（P-20261003-111
//              终端域动作入注册表：历史/片段/字号/搜索/复制粘贴/分屏/关 pane/循环切 tab，
//              TerminalView 与 useTerminalKeys 经动作 id 读生效值）
//              + views/terminal/TerminalView.vue 硬编码区间键（Alt+1-9 切标签）
//              + composables/useTerminalKeys.ts 硬编码区间键（Ctrl+Shift+1-9 切 tab）
//   editor    = stores/keymap.ts KEYMAP_ACTIONS domain:'editor' 条目（P-20261008-14
//              编辑器域自定义动作入注册表：save-file/sc-bookmark.toggle/
//              sc-ask.inline-edit，MonacoEditor 经 editorKeymapBindings 按生效值
//              addAction、改键重注册）——入 monaco 作用域（消费方同 addAction 族）；
//              消费链锚点对账见 extractEditorKeymapConsumers
//   notes     = stores/keymap.ts KEYMAP_ACTIONS domain:'notes' 条目（P-20261107-5
//              笔记面板域：notesSave/notesCreate/notesRename，useNotesKeyboard
//              document capture 消费、面板根节点包含判定）——独立作用域（焦点域）；
//              消费链锚点对账见 extractNotesKeymapConsumers
//   monaco   = editor.addAction({ keybindings: [monaco.KeyMod... | monaco.KeyCode...] })
//              （全 src 扫描；历史提案写的 addCommand 已演进为 addAction，纯右键菜单项
//              无 keybindings 不入表；编辑器域注册表动作的键位动态注入后不再有
//              monaco. 字面量，由 extractEditorKeymapConsumers 对账）
//   monitor  = views/monitor/MonitorView.vue 裸 R 刷新（大屏值守惯例）
//   approval = composables/useApprovalHotkeys.ts 待裁决卡在屏时的 1/2/3 键盘裁决
//              （P-20261003-1，case 数字 → actions 三选；帮助审批等待组承诺键的对账面）
//   vendor   = node_modules Monaco 内建默认键位（帮助编辑器组承诺的 Ctrl+F/H/D 与
//              vendored 源码核验——monaco 升级若移除键位在此暴露）
//   runtime  = src/utils/keyInventory.ts 静态键清单（P-20261003-106 保存时冲突扫描
//              数据源）与实际注册双向对账——清单条目失效/笔误，或新注册的可捕获键
//              未镜像进清单（扫描面失明）都判 error
//
// 判定规则：
//   - 同作用域重复键 → error（keymap 注册序即优先序，后注册者被遮蔽不生效）
//   - 跨作用域同键 → info 白名单不判失败：修饰域本就不同（Ctrl+1-9 面板 vs Alt+1-9
//     终端），同修饰域跨层由既有让位链消解（keymap claimsCombo 让位数字直达、xterm
//     customKeyEventHandler 先于 document 气泡链、Monaco 聚焦域独立于全局链），列出
//     仅为可见性
//   - ShortcutsHelp 对账（防文档漂移）：静态行承诺键必须存在于实际注册；keysOf('动作id')
//     必须是 KEYMAP_ACTIONS 合法动作。单向对账——注册了但帮助未列不算漂移（帮助是
//     策展子集，如 Esc 链只列一行）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcArgIdx = process.argv.indexOf('--src')
if (srcArgIdx > 0 && !process.argv[srcArgIdx + 1]) {
  console.error('用法错误：--src 需要跟目录参数（如 --src /tmp/sc-src-copy）')
  process.exit(2)
}
const SRC = srcArgIdx > 0
  ? path.resolve(process.argv[srcArgIdx + 1])
  : path.join(WEB_ROOT, 'src')
const VENDOR_CONTRIB = path.join(WEB_ROOT, 'node_modules', 'monaco-editor', 'esm', 'vs', 'editor', 'contrib')

const entries = []   // { combo, scope, where, label, variant }
const errors = []
const infos = []

function read(rel) {
  const p = path.join(SRC, rel)
  if (!fs.existsSync(p)) {
    errors.push(`锚点文件缺失：${rel}——审计面已漂移，请更新本脚本`)
    return ''
  }
  return fs.readFileSync(p, 'utf8')
}

function lineOf(text, idx) {
  return text.slice(0, idx).split('\n').length
}

/** 注册一条键位。variant 标平台互斥默认（'mac'/'win'），同 variant 重复才算冲突 */
function reg(combo, scope, where, label, variant = '') {
  const canonical = canon(combo)
  if (!canonical) {
    errors.push(`无法解析的 combo「${combo}」（${where}，${label}）`)
    return
  }
  entries.push({ combo: canonical, scope, where, label, variant })
}

/** combo 规范形：修饰符归并排序 [ctrl, alt, shift] + 主键（同 stores/keymap.ts canonicalCombo 口径）。
 *  主键 '+' 会被按位 split 吞掉（'ctrl++'.split('+') 无主键段），先探尾缀 '+' 摘出主键 */
function canon(combo) {
  let c = combo.toLowerCase().trim()
  let key = ''
  if (c.endsWith('+')) {
    key = '+'
    c = c.slice(0, -1)
  }
  const mods = []
  for (const tok of c.split('+').map(s => s.trim()).filter(Boolean)) {
    if (['ctrl', 'control', 'meta', 'cmd', 'command', 'mod'].includes(tok)) {
      if (!mods.includes('ctrl')) mods.push('ctrl')
    } else if (['alt', 'option'].includes(tok)) {
      if (!mods.includes('alt')) mods.push('alt')
    } else if (tok === 'shift') {
      if (!mods.includes('shift')) mods.push('shift')
    } else if (!key) {
      key = tok
    }
  }
  if (!key) return ''
  return [...['ctrl', 'alt', 'shift'].filter(m => mods.includes(m)), key].join('+')
}

/** 锚点断言：提取正则必须命中——注册模式漂移导致的「脚本失明」在此显式暴露而非静默漏报 */
function need(hit, what) {
  if (!hit) errors.push(`锚点未命中：${what}——注册模式已漂移，请同步更新本脚本提取正则`)
}

/** TS 源码引号字面量原文 → 逻辑值（'ctrl+\\' → ctrl+\）；仅处理本审计面会出现的转义 */
function unescapeSource(s) {
  return s.replaceAll('\\\\', '\\').replaceAll("\\'", "'")
}

function firstMatch(text, re) {
  const m = re.exec(text)
  return m ? { index: m.index } : null
}

// ---- ① global：keymap 默认表 + 锁定默认键 + 布局硬编码 ----------------------

function extractKeymap() {
  const text = read(path.join('stores', 'keymap.ts'))
  if (!text) return []
  const ids = []
  let terminalIds = 0
  let editorIds = 0
  let notesIds = 0
  // P-20261003-111 起注册表条目带 domain 字段（{ id, default, domain }），终端域
  // 动作按 domain 入 terminal 作用域（域内注册序即优先序；跨域同键是分层共存）；
  // P-20261008-14 起编辑器域动作按 domain 入 monaco 作用域（键位消费方是 addAction
  // 族，与 addAction 提取同层冲突检测）；P-20261107-5 起笔记面板域入 notes 作用域
  //（useNotesKeyboard capture 消费，独立焦点域）
  const re = /\{\s*id:\s*'([a-zA-Z0-9]+)'\s*,\s*default:\s*'([^']+)'\s*,\s*domain:\s*'([a-z]+)'\s*\}/g
  let m
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1])
    if (m[3] === 'terminal') terminalIds++
    if (m[3] === 'editor') editorIds++
    if (m[3] === 'notes') notesIds++
    // default 捕获的是 TS 源码字面量原文，'ctrl+\\' 须还原为单反斜杠逻辑值
    const scope = m[3] === 'terminal' ? 'terminal' : m[3] === 'editor' ? 'monaco' : m[3] === 'notes' ? 'notes' : 'global'
    reg(unescapeSource(m[2]), scope, `src/stores/keymap.ts:${lineOf(text, m.index)}`, `keymap:${m[1]}`)
  }
  need(ids.length > 0, 'keymap.ts KEYMAP_ACTIONS（{ id, default, domain } 表）')
  need(terminalIds >= 13, `keymap.ts 终端域动作（domain:'terminal'，实提 ${terminalIds}，基线 13）`)
  need(editorIds >= 3, `keymap.ts 编辑器域动作（domain:'editor'，实提 ${editorIds}，基线 3）`)
  need(notesIds >= 3, `keymap.ts 笔记面板域动作（domain:'notes'，实提 ${notesIds}，基线 3）`)
  return ids
}

function extractLock() {
  const text = read(path.join('stores', 'lock.ts'))
  if (!text) return
  const decl = text.indexOf('DEFAULT_LOCK_SHORTCUT')
  need(decl >= 0, 'lock.ts DEFAULT_LOCK_SHORTCUT 声明')
  if (decl < 0) return
  const seg = text.slice(decl, decl + 300)
  // 双默认声明就近 300 字符内取带 '+' 的串字面量——窗口会扫到相邻 ACTIVITY_EVENTS
  // 的 'keydown' 等事件名，无 '+' 的一律不是 combo
  const combos = [...seg.matchAll(/'([a-z0-9+]+)'/g)].map(x => x[1]).filter(c => c.includes('+') && canon(c))
  need(combos.length >= 2, 'lock.ts 平台双默认键（meta+shift+l / ctrl+shift+l）')
  const line = lineOf(text, decl)
  for (const c of combos) {
    reg(c, 'global', `src/stores/lock.ts:${line}`, 'lock-shortcut 默认', c.startsWith('meta') ? 'mac' : 'win')
  }
}

function extractLayoutHardcoded() {
  const text = read(path.join('composables', 'useLayoutKeyboard.ts'))
  if (!text) return
  const f = 'src/composables/useLayoutKeyboard.ts'
  const hit = (re) => firstMatch(text, re)

  const esc = hit(/e\.key === 'Escape'/)
  need(!!esc, 'Esc 逐层收起（e.key === \'Escape\'）')
  if (esc) reg('escape', 'global', `${f}:${lineOf(text, esc.index)}`, 'Esc 逐层收起链（硬编码单键）')

  const help = hit(/e\.key === '\?'/)
  need(!!help, '? 备忘单（e.key === \'?\'）')
  if (help) reg('?', 'global', `${f}:${lineOf(text, help.index)}`, '? 快捷键备忘单（硬编码单键）')

  const arrows = hit(/e\.altKey && \(e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'\)/)
  need(!!arrows, 'Alt+↑↓ diff 导航')
  if (arrows) {
    const line = lineOf(text, arrows.index)
    reg('alt+arrowdown', 'global', `${f}:${line}`, 'diff 导航下一条（硬编码成对键）')
    reg('alt+arrowup', 'global', `${f}:${line}`, 'diff 导航上一条（硬编码成对键）')
  }

  const digits = hit(/\/\^\[1-9\]\$\/\.test\(e\.key\)/)
  need(!!digits, 'Ctrl+1-9 数字直达（capture 相位 /^[1-9]$/）')
  if (digits) {
    const line = lineOf(text, digits.index)
    for (let d = 1; d <= 9; d++) reg(`ctrl+${d}`, 'global', `${f}:${line}`, '活动栏面板数字直达（硬编码区间键）')
  }

  // Ctrl/Cmd+Alt+1-9 工作区预设直达（P-20261004-49）：数字捕获链旁挂的 Alt 修饰
  // 分支，与面板直达共用 /^[1-9]$/ 判定与让位/门控纪律——锚点取分支独有的
  // workspacePresetCount 计数调用（deps 契约名，随消费点漂移显式暴露）
  const presets = hit(/deps\.workspacePresetCount\(\)/)
  need(!!presets, 'Ctrl+Alt+1-9 工作区预设直达（handleDigitCapture Alt 分支）')
  if (presets) {
    const line = lineOf(text, presets.index)
    for (let d = 1; d <= 9; d++) reg(`ctrl+alt+${d}`, 'global', `${f}:${line}`, '工作区预设数字直达（硬编码区间键）')
  }
}

// ---- ② terminal：TerminalView 字号/标签 + xterm customKeyEventHandler --------

function extractTerminalView() {
  const text = read(path.join('views', 'terminal', 'TerminalView.vue'))
  if (!text) return
  const f = 'src/views/terminal/TerminalView.vue'
  const at = (re) => firstMatch(text, re)

  // Alt+1-9 区间键仍在 TerminalView 硬编码（keymap 注册表不建模区间族）
  const altDigits = at(/e\.altKey && !e\.ctrlKey && !e\.metaKey && \/\^\[1-9\]\$\/\.test\(e\.key\)/)
  need(!!altDigits, 'TerminalView Alt+1-9 切终端标签')
  if (altDigits) {
    const line = lineOf(text, altDigits.index)
    for (let d = 1; d <= 9; d++) reg(`alt+${d}`, 'terminal', `${f}:${line}`, '切到第 N 个终端标签')
  }

  // 单组合键的 doc 级终端动作（历史/片段/字号/书签列表）P-20261003-111 起入
  // keymap 注册表（domain:'terminal'，键位提取见 extractKeymap），此处只对账
  // 消费链在位——TerminalView 必须经 hitDoc(动作id) 读生效值，锚点漂移说明
  // 消费链被改断
  for (const id of ['terminalHistory', 'terminalSnippet', 'terminalFontIn', 'terminalFontOut', 'terminalFontReset', 'terminalBookmarkList']) {
    const hit = at(new RegExp(`hitDoc\\('${id}'\\)`))
    need(!!hit, `TerminalView ${id} 经 hitDoc 读 keymap 生效值`)
  }
}

function extractTerminalKeys() {
  const text = read(path.join('composables', 'useTerminalKeys.ts'))
  if (!text) return
  const f = 'src/composables/useTerminalKeys.ts'
  const at = (re) => firstMatch(text, re)

  // Ctrl+Shift+1-9 切 tab 区间键仍硬编码（keymap 注册表不建模区间族）
  const switchDigits = at(/mod && event\.shiftKey && \/\^\[1-9\]\$\/\.test\(event\.key\)/)
  need(!!switchDigits, 'useTerminalKeys Ctrl+Shift+1-9 切 tab')
  if (switchDigits) {
    const line = lineOf(text, switchDigits.index)
    for (let d = 1; d <= 9; d++) reg(`ctrl+shift+${d}`, 'terminal', `${f}:${line}`, '切到第 N 个终端 tab')
  }

  // 单组合键的 xterm 级终端动作（搜索/复制/粘贴/分屏/关 pane/pane 切换/循环切 tab）
  // P-20261003-111 起入 keymap 注册表（键位提取见 extractKeymap），此处只对账
  // 消费链在位——useTerminalKeys 必须经 hit(event, 动作id) 读生效值
  for (const id of ['terminalSearch', 'terminalCopy', 'terminalPaste', 'terminalSplitH', 'terminalSplitV', 'terminalClosePane', 'termFocusOtherPane', 'terminalCyclePrev', 'terminalCycleNext']) {
    const hit = at(new RegExp(`hit\\(event, '${id}'\\)`))
    need(!!hit, `useTerminalKeys ${id} 经 hit(event, '${id}') 读 keymap 生效值`)
  }
}

// ---- ③ editor-keymap：编辑器域自定义动作消费链对账（P-20261008-14）----------
//
// save-file / sc-bookmark.toggle / sc-ask.inline-edit 三动作键位经 keymap 编辑器域
// 注册表生效值注入（views/editor/editorKeymapBindings.ts attachEditorKeymapBindings），
// 不再有静态 monaco.KeyCode 字面量供 extractMonaco 提取——此处对账消费链在位
//（锚点漂移说明接线被改断）。旧硬编码键位的防回归由 extractMonaco 同作用域重复
// 检测兜底：若有人把 monaco.KeyCode 字面量 keybindings 加回来，将与注册表 editor
// 条目同作用域同键报 error

function extractEditorKeymapConsumers() {
  const host = read(path.join('views', 'editor', 'MonacoEditor.vue'))
  if (!host) return
  need(/attachEditorKeymapBindings\(/.test(host), 'MonacoEditor.vue attachEditorKeymapBindings 接线（编辑器域键位消费链）')
  for (const id of ['editorSave', 'editorBookmarkToggle', 'editorInlineEdit']) {
    need(new RegExp(`action:\\s*'${id}'`).test(host), `MonacoEditor.vue 编辑器域动作 ${id} 经 EditorKeymapBindingSpec 注册`)
  }
  const inline = read(path.join('composables', 'useEditorInlineEdit.ts'))
  if (!inline) return
  need(/actionDescriptor\(\)/.test(inline), 'useEditorInlineEdit actionDescriptor（sc-ask.inline-edit 键位注册收敛编辑器域注册表）')
}

// ---- ③b notes-keymap：笔记面板域消费链对账（P-20261107-5） --------------------
//
// notesSave/notesCreate/notesRename 三动作键位经 keymap notes 域注册表生效值消费
//（useNotesKeyboard document capture + 面板根包含判定），此处对账消费链在位
//（锚点漂移说明接线被改断）

function extractNotesKeymapConsumers() {
  const host = read(path.join('views', 'notes', 'NotesPanel.vue'))
  if (!host) return
  need(/useNotesKeyboard\(/.test(host), 'NotesPanel.vue useNotesKeyboard 接线（笔记面板域键位消费链）')
  const kb = read(path.join('composables', 'useNotesKeyboard.ts'))
  if (!kb) return
  for (const id of ['notesSave', 'notesCreate', 'notesRename']) {
    need(new RegExp(`combos\\.${id}`).test(kb), `useNotesKeyboard.ts ${id} 经 notesActionFor 读 keymap 生效值`)
  }
}

// ---- ③ monaco：addAction keybindings（全 src 扫描） --------------------------

const MONACO_MODS = {
  'KeyMod.CtrlCmd': 'ctrl',
  'KeyMod.Alt': 'alt',
  'KeyMod.Shift': 'shift',
}
const MONACO_KEYS = {}
for (let i = 0; i < 26; i++) MONACO_KEYS[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(97 + i)
for (let d = 0; d <= 9; d++) MONACO_KEYS[`Digit${d}`] = String(d)
Object.assign(MONACO_KEYS, {
  ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright',
  Enter: 'enter', Escape: 'escape', Tab: 'tab', Space: 'space',
  Backquote: '`', Minus: '-', Equal: '=', Backslash: '\\',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: '\'',
  Comma: ',', Period: '.', Slash: '/',
  F12: 'f12',
})

function decodeMonacoExpr(expr, where) {
  const mods = []
  let key = ''
  for (const raw of expr.split('|')) {
    const tok = raw.trim()
    const m = tok.match(/^(?:monaco\.)?(KeyMod|KeyCode)\.(\w+)$/)
    if (!m) {
      errors.push(`未知 Monaco 键码「${tok}」（${where}）——请在 check-keybindings.mjs 解码表补充`)
      continue
    }
    const [, kind, name] = m
    if (kind === 'KeyMod') {
      if (!MONACO_MODS[`${kind}.${name}`]) {
        errors.push(`未知 Monaco 修饰符「${tok}」（${where}）——请补充解码表`)
        continue
      }
      if (!mods.includes(MONACO_MODS[`${kind}.${name}`])) mods.push(MONACO_MODS[`${kind}.${name}`])
    } else if (MONACO_KEYS[name]) {
      key = MONACO_KEYS[name]
    } else if (name === 'WinCtrl') {
      if (!mods.includes('ctrl')) mods.push('ctrl')
    } else {
      errors.push(`未知 Monaco 主键「${tok}」（${where}）——请补充解码表`)
    }
  }
  return key ? [...['ctrl', 'alt', 'shift'].filter(x => mods.includes(x)), key].join('+') : ''
}

function extractMonaco() {
  if (!fs.existsSync(SRC)) return
  const files = []
  ;(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(vue|ts)$/.test(e.name)) files.push(p)
    }
  })(SRC)
  const re = /keybindings:\s*\[([^\]]*monaco\.[^\]]*)\]/g
  let total = 0
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    const rel = `src/${path.relative(SRC, file).replaceAll('\\', '/')}`
    let m
    while ((m = re.exec(text)) !== null) {
      const line = lineOf(text, m.index)
      // 就近回溯 addAction 的 id 作说明（注册点惯例：id 在 keybindings 前几百字符内）
      const before = text.slice(Math.max(0, m.index - 400), m.index)
      const idMatch = [...before.matchAll(/\bid:\s*'([^']+)'\s*,/g)].pop()
      const label = idMatch ? `addAction:${idMatch[1]}` : 'addAction(keybindings)'
      const combo = decodeMonacoExpr(m[1], `${rel}:${line}`)
      if (combo) {
        reg(combo, 'monaco', `${rel}:${line}`, label)
        total++
      }
    }
  }
  need(total > 0, 'Monaco addAction keybindings（全 src 无任何命中）')
}

// ---- ④ monitor：MonitorView 裸 R 刷新 ----------------------------------------

function extractMonitor() {
  const text = read(path.join('views', 'monitor', 'MonitorView.vue'))
  if (!text) return
  const hit = firstMatch(text, /e\.key !== 'r' && e\.key !== 'R'/)
  need(!!hit, 'MonitorView 裸 R 刷新')
  if (hit) reg('r', 'monitor', `src/views/monitor/MonitorView.vue:${lineOf(text, hit.index)}`, '监控大屏 R 刷新')
}

// ---- ⑤ vendor：Monaco 内建默认键位（帮助承诺的 Ctrl+F/H/D 核验） --------------

function extractVendor() {
  if (!fs.existsSync(VENDOR_CONTRIB)) {
    errors.push(`Monaco vendor 目录缺失：${VENDOR_CONTRIB}——monaco-editor 未安装或目录结构变更`)
    return new Set()
  }
  const files = []
  ;(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) files.push(p)
    }
  })(VENDOR_CONTRIB)
  // vendored 源码把键码编为数值常量并带注释：`2048 /* KeyMod.CtrlCmd */ | 36 /* KeyCode.KeyF */`
  const re = /KeyMod\.CtrlCmd \*\/\s*\|\s*\d+ \/\* KeyCode\.Key([A-Z]) \*\//g
  const found = new Map() // 主键字母 → 首个注册文件
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('KeyCode.Key')) continue
    let m
    while ((m = re.exec(text)) !== null) {
      const letter = m[1].toLowerCase()
      if (!found.has(letter)) found.set(letter, file)
    }
  }
  const rel = (p) => `node_modules/monaco-editor/esm/vs/editor/contrib/${path.relative(VENDOR_CONTRIB, p).replaceAll('\\', '/')}`
  const expect = { f: '查找（find）', h: '替换（replace）', d: '多光标（multi-cursor）' }
  for (const [letter, name] of Object.entries(expect)) {
    if (found.has(letter)) {
      // vendor 只对账到文件级（内部注册点随 monaco 版本漂移，行号无维护价值）
      reg(`ctrl+${letter}`, 'vendor', rel(found.get(letter)), `Monaco 内建：${name}`)
    } else {
      errors.push(`帮助承诺的 Monaco 内建 Ctrl+${letter.toUpperCase()}（${name}）在 vendor 源码中未找到——monaco 升级后键位漂移，请核对 ShortcutsHelp 编辑器组`)
    }
  }
}


// ---- ⑥ approval：审批卡键盘裁决（待裁决卡在屏时 1/2/3 三选，P-20261003-99 入表） ----

function extractApprovalHotkeys() {
  const text = read(path.join('composables', 'useApprovalHotkeys.ts'))
  if (!text) return
  const f = 'src/composables/useApprovalHotkeys.ts'
  // 注册惯例：approvalHotkeyDecision 的 switch 裸数字 case → actions 动作（P-1 形态）
  const re = /case '([1-9])':\s*return actions\.(\w+)/g
  let m
  let count = 0
  while ((m = re.exec(text)) !== null) {
    count++
    reg(m[1], 'approval', `${f}:${lineOf(text, m.index)}`, `审批键盘裁决:${m[2]}`)
  }
  need(count >= 3, 'useApprovalHotkeys 键 1/2/3 裁决三选（case 数字 → actions.x）')

}

// ---- ⑦ runtime：keyInventory 静态键清单与实际注册双向对账 --------------------
//
// keyInventory.ts 是键位自定义保存时冲突扫描（P-20261003-106）的运行时数据源，
// 镜像本脚本提取的非 keymap 注册表键位。这里按行解析其字面量表做两个方向的对账：
//   ① 清单 → 注册：每条清单键必须能在实际注册中找到（防清单陈旧/笔误成死条目）
//   ② 注册 → 清单：terminal/monaco/vendor/global 硬编码域的可捕获键必须镜像进清单
//     （防新键注册后扫描面失明）。keymap 注册表动作（P-20261003-111 起含终端域，
//     label 'keymap:*'）与锁定键由 keymap store 的 conflicts 按域语义自覆盖、平台
//     互斥默认（variant）非运行时事实，均不入清单；EXEMPT 豁免不可捕获键
//     （单键无修饰符）

const INVENTORY_EXEMPT = new Set(['escape', '?', 'r'])

function checkRuntimeInventory() {
  const text = read(path.join('utils', 'keyInventory.ts'))
  if (!text) return
  const invCombos = new Map()
  const invCanonicals = new Set()
  let count = 0
  for (const line of text.split('\n')) {
    const m = line.match(/\{\s*combo:\s*'([^']+)'\s*,\s*scope:\s*'([a-z]+)'.*?\bsemantics:\s*'(?:focus|takeover)'/)
    if (!m) continue
    count++
    const canonical = canon(unescapeSource(m[1]))
    if (!canonical) {
      errors.push(`keyInventory 条目 combo「${m[1]}」无法规范化——清单键必须是 canonicalCombo 幂等形`)
      continue
    }
    // 同键跨作用域双条目合法（ctrl+f 同时镜像编辑器查找与终端搜索，同审计白名单
    // 语义）；同作用域同键才是清单重复
    const dedupKey = `${m[2]} ${canonical}`
    if (invCombos.has(dedupKey)) errors.push(`keyInventory 重复条目：${canonical}（${m[2]}）`)
    invCombos.set(dedupKey, m[1])
    invCanonicals.add(canonical)
  }
  need(count >= 32, 'keyInventory.ts 静态键清单条目（P-20261008-14 起编辑器域自定义动作 Ctrl+S/Ctrl+Alt+B/Ctrl+K 移入 keymap 注册表，基线 32）')

  const actualCombos = new Set(entries.map((e) => e.combo))
  for (const [dedupKey, raw] of invCombos) {
    const canonical = dedupKey.split(' ')[1]
    if (!actualCombos.has(canonical)) {
      errors.push(`keyInventory 条目「${raw}」未在任何作用域注册——清单与实际注册漂移，请对齐 check-keybindings 审计表`)
    }
  }
  for (const e of entries) {
    if (e.variant) continue                              // 平台互斥默认（锁定 mac/win）
    if (e.label.startsWith('keymap:')) continue          // keymap 注册表动作（含终端域）——store conflicts 按域语义自覆盖
    if (INVENTORY_EXEMPT.has(e.combo)) continue          // 不可捕获键（见上）
    if (!invCanonicals.has(e.combo)) {
      errors.push(`实际注册「${e.combo}」（${e.scope}，${e.label}）未镜像进 keyInventory——保存时冲突扫描失明`)
    }
  }}

// ---- ShortcutsHelp 对账 -------------------------------------------------------

const HELP_MODS = { Ctrl: 'ctrl', '⇧': 'shift', Shift: 'shift', Alt: 'alt', Cmd: 'ctrl' }
const HELP_KEY_NAMES = { Esc: 'escape', '↑': 'arrowup', '↓': 'arrowdown', '←': 'arrowleft', '→': 'arrowright' }

/** kbd token → 主键候选：'↑/↓' 多选、'1-9' 数字区间、其余单键 */
function expandHelpKeyToken(tok) {
  if (/^\d-\d$/.test(tok)) {
    const out = []
    for (let d = Number(tok[0]); d <= Number(tok[2]); d++) out.push(String(d))
    return out
  }
  if (tok.includes('/')) return tok.split('/')
  return [tok]
}

function reconcileHelp(keymapIds) {
  const text = read(path.join('components', 'common', 'ShortcutsHelp.vue'))
  if (!text) return
  const f = 'src/components/common/ShortcutsHelp.vue'

  // 动态行：keysOf('动作id') 必须是 KEYMAP_ACTIONS 合法动作（防改键清单引用漂移）
  let m
  const dynRe = /keysOf\('([a-zA-Z0-9]+)'\)/g
  let dynCount = 0
  while ((m = dynRe.exec(text)) !== null) {
    dynCount++
    if (!keymapIds.includes(m[1])) {
      errors.push(`${f}:${lineOf(text, m.index)} keysOf('${m[1]}') 不是 KEYMAP_ACTIONS 合法动作——帮助清单引用漂移`)
    }
  }
  need(dynCount > 0, 'ShortcutsHelp keysOf() 动态行')

  // 静态行：keys 数组承诺键 ⊆ 实际注册
  const byCombo = new Map()
  for (const e of entries) {
    if (!byCombo.has(e.combo)) byCombo.set(e.combo, [])
    byCombo.get(e.combo).push(e)
  }
  const statRe = /keys:\s*\[([^\]]+)\]/g
  let statCount = 0
  while ((m = statRe.exec(text)) !== null) {
    statCount++
    const line = lineOf(text, m.index)
    const tokens = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
    if (tokens.length === 0) {
      errors.push(`${f}:${line} keys 数组无法解析——帮助静态行格式漂移`)
      continue
    }
    const mods = []
    const keys = []
    for (const tok of tokens) {
      if (HELP_MODS[tok]) {
        if (!mods.includes(HELP_MODS[tok])) mods.push(HELP_MODS[tok])
      } else {
        for (const k of expandHelpKeyToken(tok)) keys.push(HELP_KEY_NAMES[k] ?? k.toLowerCase())
      }
    }
    for (const key of keys) {
      const combo = [...['ctrl', 'alt', 'shift'].filter(x => mods.includes(x)), key].join('+')
      if (!byCombo.has(combo)) {
        errors.push(`${f}:${line} 帮助承诺键「${combo}」在任何作用域都未注册——文档漂移（键已改绑/移除但备忘单未跟）`)
      }
    }
  }
  need(statCount > 0, 'ShortcutsHelp 静态 keys 数组行')
}

// ---- 冲突检测 + 输出 ----------------------------------------------------------

const SCOPE_ORDER = ['global', 'terminal', 'monaco', 'notes', 'monitor', 'approval', 'vendor']
// 失明守卫：各作用域最低提取数（P-20261003-111 后实际 global≈37 / terminal≈31：
// 终端域含注册表 13 动作 + Alt+1-9 / Ctrl+Shift+1-9 区间键）。低于基线说明
// 注册模式漂移使提取正则失明——显式失败优于静默漏报（对账只护得住帮助承诺过的键）
const SCOPE_MIN = { global: 30, terminal: 25, monaco: 2, notes: 3, monitor: 1, approval: 3, vendor: 3 }

function main() {
  const keymapIds = extractKeymap()
  extractLock()
  extractLayoutHardcoded()
  extractTerminalView()
  extractTerminalKeys()
  extractEditorKeymapConsumers()
  extractNotesKeymapConsumers()
  extractMonaco()
  extractMonitor()
  extractApprovalHotkeys()
  extractVendor()
  checkRuntimeInventory()
  reconcileHelp(keymapIds)

  // 失明守卫
  for (const scope of SCOPE_ORDER) {
    const n = entries.filter((e) => e.scope === scope).length
    if (n < SCOPE_MIN[scope]) {
      errors.push(`作用域 ${scope} 仅提取到 ${n} 条键位（基线 ${SCOPE_MIN[scope]}）——提取正则可能已失明，请核对注册模式`)
    }
  }

  // 同作用域重复键 → error；跨作用域同键 → info 白名单
  const byCombo = new Map()
  for (const e of entries) {
    if (!byCombo.has(e.combo)) byCombo.set(e.combo, [])
    byCombo.get(e.combo).push(e)
  }
  for (const [combo, group] of byCombo) {
    if (group.length < 2) continue
    const scopes = [...new Set(group.map((e) => e.scope))]
    if (scopes.length > 1) {
      infos.push(`${combo}：跨作用域同键（${group.map((e) => `${e.scope} ${e.where}`).join('；')}）——修饰域/聚焦域分层消解，白名单放行`)
      continue
    }
    // 成对判定：平台互斥对（mac/win 均带 variant）放行，其余（含无 variant 的
    // 裸注册混入平台对）一律冲突——裸键位全平台生效，与任一平台默认都撞
    const conflicts = []
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        if (a.variant && b.variant && a.variant !== b.variant) continue
        conflicts.push(`${a.where}（${a.label}${a.variant ? `/${a.variant}` : ''}）× ${b.where}（${b.label}${b.variant ? `/${b.variant}` : ''}）`)
      }
    }
    if (conflicts.length > 0) {
      for (const c of conflicts) errors.push(`同作用域冲突：${combo} 在 ${group[0].scope} 重复注册——${c}（注册序靠前者生效，靠后者被遮蔽）`)
    } else {
      infos.push(`${combo}：平台互斥默认键共存（${group.map((e) => `${e.variant} ${e.where}`).join('；')}），不算冲突`)
    }
  }

  // 全量键位表
  console.log('键位'.padEnd(22) + '作用域'.padEnd(10) + '注册点' + '  ' + '说明')
  console.log('-'.repeat(110))
  const sorted = [...entries].sort((a, b) =>
    SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.combo.localeCompare(b.combo))
  for (const e of sorted) {
    console.log(`${e.combo.padEnd(22)}${e.scope.padEnd(10)}${e.where}  ${e.label}${e.variant ? ` [${e.variant}]` : ''}`)
  }
  console.log(`\n共 ${entries.length} 条键位注册（${new Set(entries.map((e) => e.scope)).size} 作用域）`)
  for (const i of infos) console.log(`[info] ${i}`)
  if (errors.length > 0) {
    for (const e of errors) console.error(`[error] ${e}`)
    console.error(`\ncheck-keybindings: error ${errors.length}，info ${infos.length}——拒绝通过`)
    process.exit(1)
  }
  console.log(`\ncheck-keybindings: error 0，info ${infos.length}——通过`)
}

main()
