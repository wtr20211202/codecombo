import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import importX from 'eslint-plugin-import-x'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '**/__tests__/**', 'e2e/**'] },
  // 完整浏览器全局集（DOM 事件类型 PointerEvent/KeyboardEvent/File 等），
  // 替代手工罗列——手工清单必然缺项，新增 DOM 类型即触发 no-undef 误报
  { languageOptions: { globals: { ...globals.browser } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  // Node 侧脚本（scripts/*.mjs / *.cjs）：浏览器全局集不适用，注入 node 全局；
  // .cjs 依赖 require/__dirname 属 CommonJS 常态，关闭对应禁令
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.cjs', '**/*.mjs', '**/*.js'],
    rules: {
      // Node 脚本里 TS 推导不存在，no-undef 交给运行时/单测保证
      'no-undef': 'off',
    },
  },
  // —— 模块循环门禁（P-20261003-62）——
  // ESM 循环导入是静默运行时雷：模块求值期拿到 undefined、初始化顺序随入口漂移，
  // Go 侧有编译器挡循环，前端此前完全裸奔。maxDepth: 1 只禁直接互斥环（A↔B），
  // 间接长链（A→B→C→A）先放行，待存量清零后渐进收紧（调大 maxDepth）。
  // 注：任务书原文点名 eslint-plugin-import，其对 ESLint 的 peer 上限为 ^9，
  // 与本仓 ESLint 10 不兼容，故用同族维护分支 eslint-plugin-import-x——
  // no-cycle 规则实现等价（含 maxDepth 语义），规则名随插件命名空间为 import-x/no-cycle。
  // 修正项评估结论（同提案）：no-floating-promises（存量 182）/ no-unsafe-*（存量 1171）
  // 可缓——开启即 gate 红或 warn 噪音，且 typed lint 需 extraFileExtensions/projectService
  // 基建与 tsconfig 圈定（tests、src/__tests__、scripts 均在 project 外），待类型安全
  // 专项治理提案随治理一并开启。
  {
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver': { typescript: { alwaysTryTypes: true } },
      'import-x/extensions': ['.ts', '.tsx', '.cts', '.mts', '.js', '.mjs', '.cjs', '.vue'],
    },
    rules: {
      'import-x/no-cycle': ['error', { maxDepth: 1 }],
    },
  },
  {
    files: ['**/*.vue', '**/*.ts'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
    rules: {
      // no-undef 在 TS/Vue 下对「仅类型」DOM 全局（NotificationPermission 等）
      // 必然误报（运行时无值，globals 包不收录）——标识符存在性由 vue-tsc 权威检查
      'no-undef': 'off',

      // 类型安全
      '@typescript-eslint/no-explicit-any': 'warn',

      // 代码风格
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],

      // 防回潮规则：禁止 message.error(e.message)，请改用请求级 errorLabel 或 silent 标记
      'no-restricted-syntax': [
        'warn', // 第一阶段 warn，待稳定后改 error
        {
          // 禁止 message.error 直接传 e.message（防止 Task 15 清理后回潮）
          selector:
            "CallExpression[callee.object.name='message'][callee.property.name='error'] > MemberExpression[object.name='e'][property.name='message']",
          message:
            '禁止 message.error(e.message)，请改用请求级 errorLabel 或 silent 标记',
        },
      ],
    },
  },
  // —— 以下 override 必须位于上方主规则块之后才能生效 ——

  // E2E spec 里的 console 输出是调试/取证手段，放行（e2e/ 目录整体 ignores 已含）
  {
    files: ['tests/**/*.spec.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // app shell 级组件（Layout/Breadcrumb）：按框架惯例以单角色命名，
  // 非可复用叶子组件，multi-word 约束只针对后者
  {
    files: ['src/views/Layout.vue', 'src/components/common/Breadcrumb.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
)
