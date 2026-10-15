# 依赖面勘定 — dsh-oikonomia-eye

**读取时刻（UTC）：2026-10-15T14:30:14Z。** 源：`C:\Users\dell\Desktop\deepseek-harness\packages\experimental\oikonomia-eye`。该包当时处于**工作区未提交状态**（`git status --porcelain` 共 15 行：12 个 `M` 与 3 个 `??`），另一个执行者当时正在改它；本文所有结论只对上述时刻与下列摘要成立。

## 0. 被复制内容的摘要（sha256[:16]）

### 聚合

| 范围 | 聚合方式 | sha256[:16] |
|---|---|---|
| `src/**` | 11 个 `.ts`，`find src -name '*.ts' \| sort \| xargs sha256sum \| sha256sum` | `8126df37d813b93f` |
| 计划的拷贝集 | `src/**` + `tests/**` + `eval/stamp-entries.mjs` + `eval/reconcile.mjs`，同法聚合 | `445d96d25b6ef2a4` |

### 逐文件

| 文件 | sha256[:16] | 文件 | sha256[:16] |
|---|---|---|---|
| `src/checkpoints.ts` | `c7cafbfbb3046b5f` | `tests/assemble-trim.spec.ts` | `4472ecea7c84616f` |
| `src/command.ts` | `1865ca02c054191b` | `tests/behavior-delta.spec.ts` | `ea7b610f950599cb` |
| `src/exposure.ts` | `20909efea42d959a` | `tests/checkpoints.spec.ts` | `e940ed446ab7811a` |
| `src/gate.ts` | `b5e8bfddd3ea7df7` | `tests/composition.spec.ts` | `16ca02d2829afe5d` |
| `src/guards.ts` | `2440f024ad97ae32` | `tests/gate.spec.ts` | `c860bd02a7e18723` |
| `src/index.ts` | `586f0c4c57879499` | `tests/ledger.spec.ts` | `54ea6bf3b034c382` |
| `src/invariant.ts` | `f63d36d6a50753e7` | `tests/real-tools.spec.ts` | `aa80e4080b493b50` |
| `src/ledger.ts` | `dc7abb9134cdd33b` | `tests/resident.spec.ts` | `1b7a4c17cbb2278b` |
| `src/library.ts` | `8ab72a4f4685e550` | `tests/shape-injection.spec.ts` | `074415ae4b8e3f16` |
| `src/recall.ts` | `10c64e2993fc02e2` | `tests/stamp-entries.spec.ts` | `6576d35564c19738` |
| `src/types.ts` | `9ee5b2142f013e2d` | `tests/fixtures/composition-driver.ts` | `5f077d219fa7880c` |
| `eval/stamp-entries.mjs` | `f66747dcd36f996d` | `eval/reconcile.mjs` | `189188ad88ba0d4d` |
| `eval/reconcile-snapshot.json` | `e7f35c621b91c677` | `package.json` | `a409ca7dadaabfeb` |
| `tsconfig.json` | `bab1acdb7c813d82` | `README.zh.md` | `45f25b1fbafacfb0` |

`README.i18n.yaml` / `eval/README.i18n.yaml` 是**双语配对记录**（git blob hash），不是内容文件；它们随既有仓库的 `verify-translation-pairing` 闸门存在，独立仓库没有该闸门，见 `EXTRACTION-PLAN.md` 第 2、3 节。

## 1. `@deepseek-ai` import 全表（文件:行 → 包名）

### 1.1 `src/**` —— 运行时真正执行的代码

**值导入（运行时需要，决定 `peerDependencies`）：**

| 文件:行 | 导入形式 | 包名 | 用到的导出 |
|---|---|---|---|
| `src/index.ts:11` | **值**（`import z from`） | `@deepseek-ai/schemastery` | 默认导出，构造 `Config` 的 `z.object({...})` |
| `src/index.ts:13` | **值** | `@deepseek-ai/dsh-llm` | `boundContextSummary`、`createUserMessage` |
| `src/checkpoints.ts:13` | **值** | `@deepseek-ai/dsh-llm` | `boundContextSummary`、`createUserMessage` |

**类型导入（仅编译期）：**

| 文件:行 | 包名 | 用到的类型 |
|---|---|---|
| `src/index.ts:10` | `@deepseek-ai/cordis` | `Context` |
| `src/index.ts:12` | `@deepseek-ai/dsh-agent` | `PreStepDecision` |
| `src/index.ts:14` | `@deepseek-ai/dsh-session` | `Session`、`UserMessage` |
| `src/index.ts:15` | `@deepseek-ai/dsh-tools` | `PostToolDecision`、`PreToolDecision`、`ToolExecution`、`ToolExecutionResult` |
| `src/index.ts:17` | `@deepseek-ai/dsh-token-meter` | **空类型导入**（`import type {}`）——只为把它的事件/服务声明并进本编译单元，使 `ctx.get('tokenMeter')` 可解析 |
| `src/checkpoints.ts:11` | `@deepseek-ai/cordis` | `Context` |
| `src/checkpoints.ts:12` | `@deepseek-ai/dsh-agent` | `Agent` |
| `src/checkpoints.ts:14` | `@deepseek-ai/dsh-session` | `SessionEvent`、`UserMessage` |
| `src/checkpoints.ts:15` | `@deepseek-ai/dsh-tools` | `PostToolDecision`、`PreToolDecision`、`ToolExecution`、`ToolExecutionResult` |
| `src/command.ts:10` | `@deepseek-ai/dsh-commands` | `CommandDefinition`、`CommandResult` |
| `src/exposure.ts:1` | `@deepseek-ai/dsh-session` | `Session`、`SessionEvent` |
| `src/guards.ts:11` | `@deepseek-ai/dsh-session` | `SessionEvent` |
| `src/invariant.ts:6` | `@deepseek-ai/cordis` | `Context` |
| `src/invariant.ts:7` | `@deepseek-ai/dsh-session` | `Session`、`SessionEvent` |
| `src/invariant.ts:8` | `@deepseek-ai/dsh-invariants` | `InvariantFailure`、`InvariantInstaller` |
| `src/ledger.ts:10` | `@deepseek-ai/dsh-session` | `Session`、`SessionEvent` |
| `src/recall.ts:8` | `@deepseek-ai/dsh-llm` | `ContentBlock` |
| `src/recall.ts:9` | `@deepseek-ai/dsh-session` | `SessionEvent`、`UserMessage` |

**模块增强（declaration merging，仅编译期，但**必须在包里**）：**

| 文件:行 | 增强目标 | 增强内容 |
|---|---|---|
| `src/types.ts:63` | `declare module '@deepseek-ai/dsh-llm'` | 往 `MessageSourceMap` 注册 `'oikonomia-eye'` → `OikonomiaEyeSource` |
| `src/types.ts:383` | `declare module '@deepseek-ai/dsh-session/types'` | 往 `SessionEventMap` 注册 `'coordinate/round'` → `CoordinateRound` |

这两条决定了：`src/types.ts` 必须被消费方的类型图**看到**，否则 `'coordinate/round'` 与 `'oikonomia-eye'` 两个键在别处不存在。`src/types.ts:383` 走的是**深路径** `@deepseek-ai/dsh-session/types`（不是包根），所以该包的 `exports` 必须一直暴露这个子路径。

`src/index.ts:7`、`src/checkpoints.ts:8`、`src/command.ts:7`、`src/gate.ts:6`、`src/guards.ts:8`、`src/invariant.ts:2-3`、`src/ledger.ts:6`、`src/library.ts:7`、`src/recall.ts:5`、`src/types.ts:4` 里的 `@deepseek-ai/dsh-experimental-oikonomia-eye` 只出现在 **JSDoc `@module` 标签**里，不是解析依赖；但抽取时要逐条改写为新包名（见 `EXTRACTION-PLAN.md`）。

### 1.2 `tests/**` —— 只在开发/CI 跑

| 包名 | 出现 | 性质 |
|---|---|---|
| `@deepseek-ai/cordis` | 全部 spawn 型 spec（`Context`，值） | 运行时（测试） |
| `@deepseek-ai/dsh-agent` | 同上（`Agent`，类型） | 类型 |
| `@deepseek-ai/dsh-agent-loop` | `assemble-trim`、`behavior-delta`、`checkpoints`、`ledger`、`real-tools`、`resident`、`shape-injection`（默认导出，值） | 运行时（测试） |
| `@deepseek-ai/dsh-agent-loop-testkit` | 同上（`mountAgentLoopTestDependencies`，值） | 运行时（测试） |
| `@deepseek-ai/dsh-app-boot` | `tests/fixtures/composition-driver.ts:11`（值） | 运行时（测试） |
| `@deepseek-ai/dsh-commands` | `behavior-delta`、`checkpoints`、`ledger` 之外见下（值：`Commands`、`CommandId`） | 运行时（测试） |
| `@deepseek-ai/dsh-fs-local` | `real-tools.spec.ts:12`（值） | 运行时（测试） |
| `@deepseek-ai/dsh-fs-observation-policy` | `real-tools.spec.ts:13`（值） | 运行时（测试） |
| `@deepseek-ai/dsh-invariants` | `ledger.spec.ts:12`（值：`InvariantService`、`InvariantError`） | 运行时（测试） |
| `@deepseek-ai/dsh-llm` | 各 spec（`createUserMessage`，值） | 运行时（测试） |
| `@deepseek-ai/dsh-loader-smoke` | `tests/fixtures/composition-driver.ts:12`（值） | 运行时（测试） |
| `@deepseek-ai/dsh-session` | 各 spec（值：`SessionId`、`SessionStore`） | 运行时（测试） |
| `@deepseek-ai/dsh-token-meter` | `checkpoints.spec.ts:18`（值：`TokenMeter`） | 运行时（测试） |
| `@deepseek-ai/dsh-tool-fs` | `real-tools.spec.ts:16`（值） | 运行时（测试） |
| `@deepseek-ai/dsh-tools` | 各 spec（`defineContentToolFixture`，值） | 运行时（测试） |
| `@deepseek-ai/dsh-experimental-oikonomia-eye` | 各 spec（`import * as Eye` + `Config`） | **自引用**，抽取后改成新包名 |
| `vitest` | 各 spec | 开发 |

**跨包源码相对导入（不属于 npm 依赖面，但抽取时会断）：** `tests/*.spec.ts` 里有 7 处
`import { MockAdapter, ... } from '../../../core/agent-loop/tests/mock-adapter.ts'`
（`assemble-trim`、`behavior-delta`、`checkpoints`、`ledger`、`real-tools`、`resident`、`shape-injection`）。
这是**仓库内相对路径**，脱离 monorepo 后不存在等价物（见 `RISKS.md` R5）。

## 2. 由 1 得出的 `peerDependencies` 确切集合

### 2.1 运行时需要（**必须**是 peer：消费方运行时本来就有这些 row，装第二份会造成两个服务注册表）

| 包名 | 依据 |
|---|---|
| `@deepseek-ai/cordis` | 插件的宿主运行时；`Context` 是插件签名的一部分（`src/index.ts:10`） |
| `@deepseek-ai/dsh-llm` | 值导入（`boundContextSummary`、`createUserMessage`） |
| `@deepseek-ai/schemastery` | 值导入（`import z from`，`src/index.ts:11`）——**注意**：monorepo 里它在 `dependencies`（`workspace:^`），抽取后按仓库约定（`@deepseek-ai/cordis` 是每个 harness 包的 peer）改成 peer。它必须与宿主是**同一个实例**：cordis 的 schema 校验跨实例会失效 |
| `@deepseek-ai/dsh-session` | `SessionEvent` / `SessionEventMap` 是**宿主事件流**的类型来源，且本包对 `SessionEventMap` 做 declaration merging |
| `@deepseek-ai/dsh-tools` | `PreToolDecision` / `PostToolDecision` 是检查点协议的返回类型 |
| `@deepseek-ai/dsh-agent` | `PreStepDecision` / `Agent` 是 pre-step 协议的类型 |
| `@deepseek-ai/dsh-commands` | `CommandDefinition` / `CommandResult` 是作者命令的注册类型 |
| `@deepseek-ai/dsh-invariants` | `InvariantInstaller` 是 package-owned 不变量的注册类型 |
| `@deepseek-ai/dsh-token-meter` | `import type {}` —— 消费方**必须**能解析到它，否则 `ctx.get('tokenMeter')` 的类型面不存在；运行时缺 meter 时本包降级为 `tokenSource: 'unavailable'` |

**判据是"该包是否需要出现在消费方的运行时图里"，而不是"是否用了 `import type`"。** 因此 `dsh-agent` / `dsh-commands` / `dsh-invariants` / `dsh-token-meter` 这些**纯类型**导入仍留在 peer：它们的类型是消费方已有的 row 的类型，devDependencies 里放一份**另一个版本的**声明会让插件按错的协议签名编译通过（见 2.2）。

### 2.2 仅类型需要（已由 `devDependencies` 解决）

**结论：无法靠 `devDependencies` 单独解决，因此它们同时出现在两处。** 理由：

- `peerDependencies` 保证**消费方**那一侧存在这些包（`auto-install-peers=false`，pnpm 不会替它装）；
- `devDependencies` 只是让**本仓库**能 `tsc --noEmit` 与跑测试。pnpm 的 peer 依赖（`auto-install-peers=false` 时）不会自动落到 `node_modules`，所以本地类型检查需要 dev 侧一份。

两处都写时，dev 侧的版本必须是 peer 区间内的**代表版本**，否则本地编译用的声明与消费方运行时的声明不是同一份。本骨架把 dev 侧钉在 `^0.1.7-rc.2`（写作时的最新非 alpha 线），并**已知**它与 `0.2.x` 的 peer 区间不同线 —— 抽取步骤要在 `0.1.7-rc.2` 与 `0.2.0-rc.2` 两条腿上各跑一次 typecheck（见 `RISKS.md` R2）。

### 2.3 测试专用（只进 `devDependencies`）

`@deepseek-ai/dsh-agent-loop`、`@deepseek-ai/dsh-agent-loop-testkit`、`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-fs-local`、`@deepseek-ai/dsh-fs-observation-policy`、`@deepseek-ai/dsh-loader-smoke`、`@deepseek-ai/dsh-tool-fs`，加 `vitest`。

**已查证（对 npmmirror registry 逐个 HTTP 查询）：这 7 个全部已发布**，各 32–34 个版本，最新为 `0.2.1-alpha.4`。因此测试套件的依赖面可以在独立仓库里从 npm 装齐（`dsh-agent-loop-testkit`、`dsh-loader-smoke`、`dsh-app-boot` 虽是仓库测试基础设施，但已随线发布）。这解决了"依赖不可得"的问题，但**没有**解决跨包**源码相对导入**的问题（见 §1.2 末与 `RISKS.md` R5）。

### 2.4 第三方运行时依赖

| 包名 | 位置 | 依据 |
|---|---|---|
| `yaml` | `dependencies` | `src/library.ts:13` `import { parse } from 'yaml'` —— 与本包一起发布的普通运行时依赖，**不是** peer（消费方不需要与它共享实例） |

## 3. peer 区间

所有 `@deepseek-ai/dsh-*` 用同一串 **rc 区间 OR 链**（照既有插件仓库样式），逐字如下：

```
>=0.1.2-rc.1 <0.1.3 || >=0.1.3-rc.1 <0.1.4 || >=0.1.4-rc.1 <0.1.5 || >=0.1.5-rc.1 <0.1.6 || >=0.1.6-rc.1 <0.1.7 || >=0.1.7-rc.1 <0.1.8 || >=0.1.8 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0
```

用 `semver` 7.8.5 实测（`semver.validRange` 非空，逐版本 `satisfies`）：

| 版本 | 是否满足 |
|---|---|
| `0.1.0-rc.7` | ❌ |
| **`0.1.1-rc.2`（本包工作区版本）** | ❌ |
| `0.1.2-rc.1` | ✅ |
| `0.1.5-rc.3` | ✅ |
| `0.1.7-rc.2` | ✅ |
| `0.2.0-rc.2` | ✅ |
| `0.2.1-alpha.4` | ❌ |
| `0.3.0-rc.1` | ❌ |

**这条区间排除了本包自己的工作区版本 `0.1.1-rc.2`。** 从 npm 查证：`@deepseek-ai/dsh-session`、`dsh-llm`、`dsh-tools`、`dsh-agent`、`dsh-commands`、`dsh-invariants`、`dsh-token-meter` 的**最旧非 alpha 发布**都早于 `0.1.2-rc.1`，而 registry 上不存在 `0.1.1-rc.2` —— 那是工作区内部版本，从未发布。因此区间是对的，但抽取步骤必须验证：**本包用到的每一个导出，在区间下界的 `0.1.2-rc.1` 里都存在**（`boundContextSummary`、`createUserMessage`、`defineContentToolFixture`、`SessionEventMap` 的 `coordinate/round` 注册点、`CommandId`…）。本轮**没有**做这项下界验证（见 `RISKS.md` R2）。

`@deepseek-ai/cordis` 用 `^4.0.2`（写入时最新为 `4.0.5-alpha.2`，工作区链接的是 `4.0.1`）。`@deepseek-ai/schemastery` 用 `^3.18.1`（写入时最新为 `3.18.5-alpha.2`，工作区链接的是 `3.18.1`）。
