// .gitignore 模板预设常量表（P-20261002-76）：Node / Go / Python / 通用 四套。
// 仅数据无逻辑：展示说明走 i18n（git.ignoreSuggest.desc.<id>，双语），内容为
// 语言无关的 gitignore 规则文本，创建时整篇写入项目根 .gitignore。
// 扩展方式：追加一项（id 唯一）+ 补对应 desc 文案即可，模板弹层自动枚举。

export type GitignoreTemplateId = 'node' | 'go' | 'python' | 'generic'

export interface GitignoreTemplate {
  id: GitignoreTemplateId
  /** 展示名（技术专名，双语同形，不走 i18n） */
  name: string
  /** 说明文案 i18n 键（git.ignoreSuggest.desc.*，zh/en 双语） */
  descKey: string
  /** 完整 .gitignore 文件内容（写盘即此文本，以换行结尾） */
  content: string
}

export const GITIGNORE_TEMPLATES: GitignoreTemplate[] = [
  {
    id: 'node',
    name: 'Node.js',
    descKey: 'git.ignoreSuggest.desc.node',
    content: [
      '# Dependencies',
      'node_modules/',
      '',
      '# Build output',
      'dist/',
      'dist-ssr/',
      'build/',
      'coverage/',
      '',
      '# Logs',
      '*.log',
      'npm-debug.log*',
      'yarn-debug.log*',
      'yarn-error.log*',
      'pnpm-debug.log*',
      '',
      '# Env & secrets',
      '.env',
      '.env.local',
      '.env.*.local',
      '',
      '# Editor',
      '.idea/',
      '.vscode/',
      '*.sw?',
      '',
    ].join('\n'),
  },
  {
    id: 'go',
    name: 'Go',
    descKey: 'git.ignoreSuggest.desc.go',
    content: [
      '# Build output',
      '*.exe',
      '*.exe~',
      '*.dll',
      '*.so',
      '*.dylib',
      '*.test',
      '*.out',
      'bin/',
      'dist/',
      '',
      '# Dependency directories',
      'vendor/',
      '',
      '# Go workspace',
      'go.work',
      'go.work.sum',
      '',
      '# Env & secrets',
      '.env',
      '.env.local',
      '',
      '# Editor',
      '.idea/',
      '.vscode/',
      '*.sw?',
      '',
    ].join('\n'),
  },
  {
    id: 'python',
    name: 'Python',
    descKey: 'git.ignoreSuggest.desc.python',
    content: [
      '# Byte-compiled / cache',
      '__pycache__/',
      '*.py[cod]',
      '.pytest_cache/',
      '.mypy_cache/',
      '.ruff_cache/',
      '',
      '# Distribution / packaging',
      'build/',
      'dist/',
      '*.egg-info/',
      '',
      '# Virtual environments',
      '.venv/',
      'venv/',
      '',
      '# Env & secrets',
      '.env',
      '.env.local',
      '',
      '# Editor',
      '.idea/',
      '.vscode/',
      '*.sw?',
      '',
    ].join('\n'),
  },
  {
    id: 'generic',
    name: 'Generic',
    descKey: 'git.ignoreSuggest.desc.generic',
    content: [
      '# OS',
      '.DS_Store',
      'Thumbs.db',
      'desktop.ini',
      '',
      '# Logs',
      '*.log',
      'logs/',
      '',
      '# Temp / build output',
      'tmp/',
      'out/',
      'dist/',
      'build/',
      '',
      '# Env & secrets',
      '.env',
      '.env.local',
      '',
      '# Editor',
      '.idea/',
      '.vscode/',
      '*.sw?',
      '',
    ].join('\n'),
  },
]

/** 表非空由常量表定义保证；未命中（不可能的 id）回落首项，调用方免 undefined 分支 */
export function gitignoreTemplateById(id: GitignoreTemplateId): GitignoreTemplate {
  return GITIGNORE_TEMPLATES.find(tpl => tpl.id === id) ?? GITIGNORE_TEMPLATES[0]!
}

