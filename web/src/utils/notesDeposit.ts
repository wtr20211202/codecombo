/**
 * 笔记「结论沉淀」模板构建（P-20261003-292，纯函数）：
 * 任务终态（done/failed）把结论追加进笔记的人机共享约定——
 * 标题「## <日期> <任务简称>」+ 3~5 行结论（结果/做了什么/关键决定/遗留项）。
 * 标签文案由调用方经 labels 传入（本模块不依赖 i18n，可在 jsdom 单测）；
 * 追加语义与 ops 手册约定一致：写前先读、整份写回（last-writer-wins）。
 *
 * P-20261108-3 单库化：笔记是项目无关的单库，项目归属靠标题前缀「[项目名] 」——
 * 沉淀落「[项目名] <交接词>」单篇（handoverNoteTitle），会话启动上下文按同一
 * 前缀找项目篇（notesTitlePrefix / hasProjectNotePrefix）；与服务端存量迁移的
 * 前缀格式（store.migratedTitle「[项目名] 原标题」）同构
 */

/** 项目篇标题前缀「[项目名]」（不含尾随空格——前缀判定兼容迁移篇「[项目名]」
 *  空标题形态）。项目名两端空白剥除 */
export function notesTitlePrefix(projectName: string): string {
  return `[${projectName.trim()}]`
}

/** 标题是否属于该项目（「[项目名]」整段前缀，其后为空或空白分隔——防
 *  「[app]」误中「[app2] …」这类前缀子串） */
export function hasProjectNotePrefix(title: string, projectName: string): boolean {
  const prefix = notesTitlePrefix(projectName)
  if (!title.startsWith(prefix)) return false
  const rest = title.slice(prefix.length)
  return rest === '' || /^\s/.test(rest)
}

/** 项目交接篇标题「[项目名] <交接词>」（交接词由调用方经 i18n 传入） */
export function handoverNoteTitle(projectName: string, handoverWord: string): string {
  return `${notesTitlePrefix(projectName)} ${handoverWord.trim()}`
}

/** 模板节内各字段的本地化文案（调用方从 i18n 取值后传入） */
export interface DepositTemplateLabels {
  /** 「结果」字段名 */
  result: string
  /** 「做了什么」字段名 */
  what: string
  /** 「关键决定」字段名 */
  decisions: string
  /** 「遗留项」字段名 */
  leftovers: string
  /** 终态 done 的展示词 */
  done: string
  /** 终态 failed 的展示词 */
  failed: string
}

/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，跨时区日期会漂——按本地时区取） */
export function localDateStr(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 任务终态是否可沉淀（running 等非终态不出口） */
export function isDepositStatus(status: string | undefined | null): boolean {
  return status === 'done' || status === 'failed'
}

/** 构建一节沉淀结论（标题 + 结果/做了什么/关键决定/遗留项占位，人可编辑补全）。
 *  task 空串由调用方兜底为占位任务名，本函数不截断（任务简称约定由调用方保证） */
export function buildDepositSection(date: string, task: string, status: 'done' | 'failed', labels: DepositTemplateLabels): string {
  const statusWord = status === 'failed' ? labels.failed : labels.done
  return [
    `## ${date} ${task}`,
    '',
    `- ${labels.result}：${statusWord}`,
    `- ${labels.what}：`,
    `- ${labels.decisions}：`,
    `- ${labels.leftovers}：`,
    '',
  ].join('\n')
}

/** 把沉淀节追加到现有笔记末尾（整份内容返回，直接可 PUT）：
 *  空笔记即整节起头；已有内容截掉尾部空白后以空行衔接新节（markdown 节间
 *  分隔约定，也防已有内容缺尾换行时标题黏上一段） */
export function appendDepositSection(existing: string, section: string): string {
  const base = existing.trimEnd()
  return base === '' ? section : `${base}\n\n${section}`
}
