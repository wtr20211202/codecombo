/**
 * 项目规则文件清单与最小模板（P-20261003-181）：
 * agent 规则文件（CLAUDE.md/AGENTS.md/.cursorrules）是 agent 行为的项目级配置。
 * 清单从紧（提案约束）：只收 Claude Code / 通用 agent / Cursor 三类已知文件名，
 * 不做通配扫描——新规则格式出现时在此追加一行即全链生效（列表/模板/描述同源）。
 * 模板正文是落盘文件内容而非 UI 文案，不入 locale；跟随界面 locale 选择语言，
 * 未列 locale 一律英文兜底（文件内容面向 agent，英文是最大公约数）。
 */

/** 已知 agent 规则文件名（项目根相对路径；顺序即面板展示序） */
export const PROJECT_RULE_FILES = ['CLAUDE.md', 'AGENTS.md', '.cursorrules'] as const

export type ProjectRuleFile = (typeof PROJECT_RULE_FILES)[number]

/** 模板正文（数组 join 合成，避开模板字面量内嵌 ``` 围栏的转义噪音） */
const TEMPLATES: Record<ProjectRuleFile, Record<'zh-CN' | 'en-US', string[]>> = {
  'CLAUDE.md': {
    'zh-CN': [
      '# CLAUDE.md',
      '',
      '本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指导。',
      '',
      '## 项目概述',
      '',
      '<!-- 一句话说明项目是什么、技术栈与核心能力 -->',
      '',
      '## 常用命令',
      '',
      '<!-- 构建 / 测试 / lint 等常用命令，例如：',
      '     npm run build',
      '     npm run test',
      '-->',
      '',
      '## 代码约定',
      '',
      '<!-- 目录结构、命名风格、仓库特有红线；agent 必须遵守的约束写在这里 -->',
      '',
    ],
    'en-US': [
      '# CLAUDE.md',
      '',
      'This file guides Claude Code (claude.ai/code) when working in this repository.',
      '',
      '## Overview',
      '',
      '<!-- One paragraph: what this project is, the stack, core capabilities -->',
      '',
      '## Commands',
      '',
      '<!-- Build / test / lint commands, e.g.:',
      '     npm run build',
      '     npm run test',
      '-->',
      '',
      '## Conventions',
      '',
      '<!-- Layout, naming style, repo-specific rules the agent must follow -->',
      '',
    ],
  },
  'AGENTS.md': {
    'zh-CN': [
      '# AGENTS.md',
      '',
      '本文件为编码智能体（Codex 等通用 agent）在本仓库工作时提供指导。',
      '',
      '## 项目概述',
      '',
      '<!-- 一句话说明项目是什么 -->',
      '',
      '## 常用命令',
      '',
      '<!-- 构建 / 测试 / lint 等常用命令 -->',
      '',
      '## 代码约定',
      '',
      '<!-- agent 必须遵守的仓库约定与红线 -->',
      '',
    ],
    'en-US': [
      '# AGENTS.md',
      '',
      'This file guides coding agents (Codex etc.) when working in this repository.',
      '',
      '## Overview',
      '',
      '<!-- One paragraph: what this project is -->',
      '',
      '## Commands',
      '',
      '<!-- Build / test / lint commands -->',
      '',
      '## Conventions',
      '',
      '<!-- Repo-specific conventions and rules the agent must follow -->',
      '',
    ],
  },
  '.cursorrules': {
    'zh-CN': [
      '# 项目规则（Cursor）',
      '',
      '<!-- Cursor 等编辑器内 AI 助手遵循的项目规则，逐条列出 -->',
      '',
      '- 语言与框架：',
      '- 命名风格：',
      '- 禁止事项：',
      '',
    ],
    'en-US': [
      '# Project Rules (Cursor)',
      '',
      '<!-- Rules followed by in-editor AI assistants (Cursor etc.), one per line -->',
      '',
      '- Languages & frameworks:',
      '- Naming style:',
      '- Do not:',
      '',
    ],
  },
}

/** 按文件名 + locale 取最小模板正文；未知文件名返回空串（调用方不得落盘空模板） */
export function ruleFileTemplate(name: string, locale: string): string {
  const lang: 'zh-CN' | 'en-US' = locale === 'zh-CN' ? 'zh-CN' : 'en-US'
  const entry = (TEMPLATES as Record<string, Record<'zh-CN' | 'en-US', string[]> | undefined>)[name]
  return entry ? entry[lang].join('\n') : ''
}
