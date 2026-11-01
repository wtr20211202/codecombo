// monaco-editor 深路径模块的既类型面（P-20261005-195 面包屑符号段引入）。
// monaco 0.55 只给主入口发 .d.ts（editor.api.d.ts），深路径无声明——TS7016；
// monaco-nls.d.ts 同先例按用到的模块逐个补最小使用面（非全量镜像）。
//
// 用途：symbolCrumbBridge.ts 经 StandaloneServices.get(ICommandService) 直调
// VS Code 内建命令 `_executeDocumentSymbolProvider` 拿返回值（editor.trigger
// 同命令会丢弃返回值不可用；monaco 0.55 已无 DocumentSymbolProviderRegistry）。

declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  /** 独立编辑器 DI 容器（monaco.editor.create 内部同一单例）的最小使用面：
   *  serviceId 真实类型是 DI Identifier 品牌类型，此处最小化为 unknown 通行 */
  export const StandaloneServices: {
    get<T>(serviceId: unknown): T
  }
}

declare module 'monaco-editor/esm/vs/platform/commands/common/commands.js' {
  /** 命令服务 DI 标识（StandaloneServices.get 的键） */
  export const ICommandService: unknown
  /** ICommandService 最小使用面：按 id 直调全局命令并取返回值 */
  export interface CommandServiceLike {
    executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T | undefined>
  }
}

declare module 'monaco-editor/esm/vs/editor/common/services/languageFeatures.js' {
  /** 语言特性服务 DI 标识（StandaloneServices.get 的键） */
  export const ILanguageFeaturesService: unknown
  /** 语言特性注册表最小使用面（仅符号收集的观测面） */
  export interface LanguageFeatureRegistryLike {
    /** 当前模型可用的 provider 有序集（语言服务惰性激活时序观测用） */
    ordered(model: unknown): unknown[]
    /** provider 注册表变化事件——TS 等语言服务在模型创建后才惰性激活注册
     *  provider，首挂收集会扑空，此处是重收集的权威触发源 */
    onDidChange(listener: () => void): { dispose(): void }
  }
  /** ILanguageFeaturesService 最小使用面（只取符号注册表一族） */
  export interface LanguageFeaturesServiceLike {
    documentSymbolProvider: LanguageFeatureRegistryLike
  }
}
