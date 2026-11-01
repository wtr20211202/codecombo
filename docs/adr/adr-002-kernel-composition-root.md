# ADR-002 kernel 组合根与依赖注入方向——下行定义接口，上行组合根注入

- 状态：已采纳　日期：2026-10-04

## 背景

模块化拆分（docs/design/module-split-plugin-foundation.md）后 `server/` 有 60 余包，
历史上出现过 `api/shared ↔ store ↔ notification` 真实循环依赖。分层规则此前只活在
代码注释里（如「notification 不能反向 import store」），编译期不可见——多会话并行
开发恰是规则遗忘高发环境，谁依赖谁必须有一个机器可查的答案。

## 决策

依赖方向总规则一句话：**下行定义接口，上行经组合根注入；被依赖方永远不 import 依赖方。**

1. **kernel 是唯一生命周期契约与最底层**（`server/kernel/kernel.go`，仅依赖 model +
   标准库）：模块只依赖 Kernel 门面（Events/Scheduler/Logger/Modules），启动顺序由
   `DependsOn` 拓扑排序表达，组合根不承担「先装 A 才能装 B」的顺序知识；
2. **组合根 = `server/app/`**（`app.go` + `modules.go`）：`builtinModules()` 是模块
   注册唯一清单（即 `/api/modules` 唯一来源）；跨层回调一律由组合根装配——
   `middleware.ApprovalNotifier` 函数变量（app.go:222）、`update.SetRestartHook`
   （app.go:433）、启动期迁移（`peercert.MigrateLegacy` / `MigrateLegacyPem` /
   `cleanupOrphanKinds`）；CLI 覆盖只存在于组合根 `runtimeInfo`，模块经构造参数
   声明式获取，不各自重读配置；
3. **包间桥接用 init() 自注册**（不引新全局）：如 `providers` 包 init 内
   `auth.SetProviderLookup(FindByPlatform)` 打断 auth ↔ providers 环；
4. **分层纪律是 CI 门禁**：`server/archguard` 用 go/parser 扫 import 块对禁令表
   （R1–R11）FAIL（P-20261003-17）。新禁令先跑 `TestPackageDependencyBoundaries`
   确认现存合规再入表；发现违规修依赖方向（组合根注入/函数口/总线桥接均为既有
   解法），**不得为转绿而放宽禁令**。

## 后果

- 正面：边界违规在 `go test` 即暴露、无需人工 review 兜底；模块契约是未来插件
  manifest 的子集（Phase D 插件化无需二次改造）；
- 约束（刻意为之）：每条新边界须同步 archguard 规则表并写 why 锚点；包改名会触发
  规则表防漂移检查——这是守护生效的信号，不是误报；
- 新代码禁止包级可变全局（既有清单除外），行为注入走构造参数或模块 Init。

## 关联

- P-20261003-17（archguard 门禁，合入 dc14626）；扩展点全表见
  [docs/EXTENSION_POINTS.md](../EXTENSION_POINTS.md)
- 锚点：`server/archguard/archguard_test.go`（规则表 R1–R11）、
  `server/app/modules.go`（`builtinModules`）、`server/kernel/kernel.go`（`Module` 契约）
