# 风险清单 — dsh-oikonomia-eye 抽取

按"会不会在抽取时才炸"排序。每条给出：现象、根因、判据（怎么知道它真的发生了）、处置。
**标注【未验证】的条目是本轮没有实测、只依据读到的代码与配置推断的结论。**

## R1 —— 混用 workspace 链接与 tsconfig `paths`，脱离 monorepo 后必须换成 peerDeps + 独立编译

**现象（源）**：同一个 `@deepseek-ai/dsh-llm` 在两种解析下是**两个不同的东西**：

- `package.json` 里 `"@deepseek-ai/dsh-llm": "workspace:^"` —— pnpm 把它链到 workspace 包；
- 根 `tsconfig.base.json` 的 `paths` 把它映射到 **`packages/llm/llm/src`**（源平面），因此 `tsc` 读的是**源码**，不是 `lib/types`；
- 包自己的 `tsconfig.json` 又有 11 条 `references` 指向那些源码工程。

**根因**：源平面的解析靠 `paths` + project references，两者都是**仓库级**设施。

**判据**：抽取后 `pnpm run typecheck` 在 `tsc` 找不到 `@deepseek-ai/*` 的 `.d.ts`、或解析到**另一条版本线**的声明时报错；
更深一层是"编译通过但协议签名不同线"（见 R2）。

**处置**：本 kit 的 `tsconfig.json` 已是独立配置（noEmit+strict，`include: ["src","tests"]`，无 `paths`、无 `references`）。
**必须实测**：`verbatimModuleSyntax` 从 `false` 改 `true`、以及缺 `exactOptionalPropertyTypes` 的差异（见 EXTRACTION-PLAN.md §2.2 第 3 条）会不会让源码报错。**这是纯编译面，必须真跑，不能推断。**

## R2 —— peer 区间与"实际工作区版本"不同线；**【本轮已解决】四条 API 分歧已前移**

> **本轮（第二次前移）结论：源码已能对着 `0.1.7-rc.2` 编译、构建并发声。**
> `typecheck` 75 → **0**；`test` 32 过 / 45 挂 → **75 过 / 2 挂**；`tsup` 的声明构建**首次通过**。
> 四条分歧的发布线真实 API、最小修法与前移后残留见 §2.4–2.6 与 R8。
> 下面 §2.0 是被本轮实测取代的原始判断，保留以便追溯。

### 2.0 原始现象（保留；其中"三个符号从未发布"的判断已被本节推翻）

**现象**：写入时工作区是 `0.1.1-rc.2`，而本 kit 的 peer 区间下界是 `0.1.2-rc.1`。
用 `semver` 7.8.5 实测：该区间**拒绝** `0.1.1-rc.2`（也拒绝 `0.1.0-rc.7`），接受 `0.1.2-rc.1`/`0.1.5-rc.3`/`0.1.7-rc.2`/`0.2.0-rc.2`，拒绝 `0.2.1-alpha.4`/`0.3.0-rc.1`。

**根因**：`0.1.1-rc.2` 是工作区内部版本，**registry 上不存在**（已查证）；区间起点照既有插件仓库样式取 `0.1.2-rc.1`。

**判据**：在 `0.1.2-rc.1` 上装齐 peer 后跑 typecheck；若某个导出（`boundContextSummary`、`createUserMessage`、`defineContentToolFixture`、`CommandId`、`SessionEventMap` 的注册点）在该版本不存在，即命中。

**处置（本轮已做完）**：下界验证做了，**结论是区间站得住、但源码站不住**。方法：从 registry 下载
`0.1.2-rc.1` 与 `0.2.0-rc.2` 两条线的 9 个 peer tarball，解包后**按各包 manifest 自己声明的 root types 入口**
（`exports["."].types` / `types`）解析其 `export ... from` 与 `export *` 图，再断言本包用到的每个符号是否可达。

| 本包用到的符号 | `0.1.2-rc.1`（区间下界） | `0.2.0-rc.2`（上一条线） | `0.1.7-rc.2`（开发钉住） |
|---|---|---|---|
| `cordis` `Context` | 有 | 有 | 有 |
| `dsh-agent` `Agent` / `PreStepDecision` | 有 | 有 | 有 |
| `dsh-commands` `CommandDefinition` / `CommandId` | 有 | 有 | 有 |
| `dsh-invariants` `InvariantInstaller` / `InvariantFailure` | 有 | 有 | 有 |
| `dsh-llm` `boundContextSummary` / `createUserMessage` | 有 | 有 | 有 |
| `dsh-llm` `MessageSourceMap`（declaration merging 的落点） | 有 | 有 | 有 |
| `dsh-session` `Session` / `SessionEvent` / `SessionEventMap` | 有 | 有 | 有 |
| `dsh-tools` `PreToolDecision` / `defineContentToolFixture` | 有 | 有 | 有 |
| **`dsh-llm` 包根导出的 `CallId`** | **无** | **无** | **无** |
| **`dsh-session` 的 `Session.events` 成员** | **无** | **无** | **无** |
| **`MessageSourceMap` 的 `'plugin'` 键** | **有** | **无** | **无** |

**区间本身是诚实的**（八个版本接受/拒绝全部与预期一致，`pnpm run peers:assert` 已把它固化成脚本并在 CI 跑）。
但**包源码不诚实**：它依赖三个从未发布的 API，因此 `pnpm run typecheck` 报 75 个错误、
`pnpm run test` 77 个用例挂 45 个。**这是"源码与已发布线不同步"，不是"区间写错"** ——
区间收窄到哪条线都不解决问题，因为三条线全都没有 `Session.events`。
`dsh-compat` CI leg 现在既断言区间接受该线（原有），也在本仓库跑 `peers:assert`（新增）；
但**它仍然不断言导出是否存在**：在当前源码状态下加一次真 import 只会红，等编译阻塞清掉后再加。

### 2.4 **【本轮实测】** 四条 API 分歧的发布线真实形态与最小修法

方法：从 registry 下载三条线的真 tarball（`0.1.2-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.2` 的
`dsh-session`、`dsh-llm`、`dsh-agent`、`dsh-tools`、`dsh-system-prompt`、`dsh-agent-loop`、
`dsh-agent-loop-testkit`），解包后**按各包 `exports["."].types` 声明的入口**读 `.d.ts` 原文。
每条给"包名 + 版本 + 文件:行 + 原文"。

**分歧 1 —— `Session.events`：三条线都没有这个成员；等价物是 `snapshotEvents()`。**

| 包 / 版本 | 文件:行 | 原文 |
|---|---|---|
| `@deepseek-ai/dsh-session@0.1.2-rc.1` | `lib/types/index.d.ts:184` | `snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[];` |
| `@deepseek-ai/dsh-session@0.1.7-rc.2` | `lib/types/index.d.ts:193` | 同上，另带 `@deprecated Existing logic may remain unmigrated for now, but new calls are prohibited.` |
| `@deepseek-ai/dsh-session@0.2.0-rc.2` | `lib/types/index.d.ts:193` | 同上 |
| `@deepseek-ai/dsh-session@0.1.7-rc.2` | `lib/types/index.d.ts:110` | `get surface(): SessionSurface;` |
| `@deepseek-ai/dsh-session@0.1.7-rc.2` | `lib/types/surface.d.ts:118-125` | `export interface SessionSurface { readonly nodes: readonly SessionSeq[]; readonly replaceGeneration: number; readonly contentGeneration: number; }` |

**"新访问器的学名"是 `snapshotEvents()`，不是 `surface`。** `session.surface` 只给 `nodes`
（`SessionSeq` 序号数组），**不是日志**；`snapshotEvents()` 的返回类型与语义（"deeply frozen events" 的
只读快照）与工作区的 `get events()` 逐字对应，因此它就是替换名。三条线上 `session.events` 都是
`Property 'events' does not exist on type 'Session'` —— 本轮 75 个基线错误里有 29 个是它。

**分歧 2 —— `CallId`：改名了，且包根没有这个名字。**

| 包 / 版本 | 文件:行 | 原文 |
|---|---|---|
| `@deepseek-ai/dsh-llm@0.1.7-rc.2` | `lib/types/brand.d.ts:31` | `export declare function ToolCallId(id: string): ToolCallId;` |
| `@deepseek-ai/dsh-llm@0.1.7-rc.2` | `lib/types/brand.d.ts:25` | `export type ToolCallId = Branded<'ToolCallId'>;` |
| `@deepseek-ai/dsh-llm@0.1.7-rc.2` | `lib/types/types.d.ts:85-86` | `export interface ToolCallBlock { type: 'tool-call'; id: ToolCallId; … }` |
| `@deepseek-ai/dsh-llm@0.1.7-rc.2` | `lib/types/index.d.ts:17` | `export * from './brand.ts';` |
| `@deepseek-ai/dsh-llm@0.1.2-rc.1` / `0.2.0-rc.2` | 同上三处 | 同名同形（三条线一致） |

**因此这不是"模块解析问题"，而是"函数改名了"**：工作区叫 `CallId`
（`packages/llm/llm/src/brand.ts:31`），三条发布线叫 `ToolCallId`，且包根确实不含 `CallId`
（对 `index.d.ts` 的 `CallId` 计数为 0 —— 它只是 `export *` 了 `./brand.ts`，而 brand 里那个名字是
`ToolCallId`）。三条线的 `exports` 都有 `"./brand"` 子路径，所以最小修法是**改名字 + 显式走子路径**：
`import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'`。
**本包源码对 `CallId` 零命中**；命中它的是两处**测试/夹具**：`tests/support/mock-adapter.ts:18,47`
与 `examples/fixtures/oikonomia-eye/oikonomia-eye-fixture.ts:10,46`。

**分歧 3 —— `MessageSourceMap['plugin']`：只有下界有；上两条线是"结构性删除"。**

| 包 / 版本 | 文件:行 | 原文 |
|---|---|---|
| `@deepseek-ai/dsh-llm@0.1.2-rc.1` | `lib/types/message.d.ts:98-101` | `plugin: { kind: 'plugin'; plugin: string; } & ContextFormed;` |
| `@deepseek-ai/dsh-llm@0.1.7-rc.2` | `lib/types/message.d.ts:101-108` | `user` / `model` / `tool` / `'system-prompt'` —— **无 `plugin`** |
| `@deepseek-ai/dsh-llm@0.2.0-rc.2` | `lib/types/message.d.ts:101-108` | 同上 |
| `@deepseek-ai/dsh-llm@0.1.7-rc.2` | `lib/types/message.d.ts:92-94` | `Merge-extensible sum type — each producer declares its own kind in its own module; there is no shared catch-all plugin kind.` |

这条不只是"换个键名"：发布线**取消了共享的 `plugin` 类型**，改成"每个生产者在自己的模块里声明自己的
`kind`"。本包自己的 `'oikonomia-eye'` 正是这个形态，所以 `src/index.ts` 那处临时消息**可自解**
（`src/types.ts:63-67` 已有声明），不需要知道发布线把该键改成了什么。
**但同一句话也标出本包的一处真实能力损失**：`foreignReminders()`（原 `src/index.ts:146-149`）以
`kind === 'plugin'` 识别"别的插件塞进来的提醒"，该 kind 在 `0.1.7-rc.2` / `0.2.0-rc.2` 上不存在。
前移后改为"kind 不属于 `user|model|tool|system-prompt` 者即外来"，语义近似而**不再等价**：发布线上同批次里
`kind: 'user'` 的消息不再计入。见 §2.5 与 R10。

**分歧 4 —— `agentLoop.create()` 返回 `Promise<Agent>`；`followup` 仍在 `Agent` 上、未改名。**

| 包 / 版本 | 文件:行 | 原文 |
|---|---|---|
| `@deepseek-ai/dsh-agent-loop@0.1.7-rc.2` | `lib/types/index.d.ts:135` | `create(id: SessionId, options?: AgentOptions, meta?: Pick<SessionHeader, 'cwd'>): Promise<Agent>;` |
| `@deepseek-ai/dsh-agent-loop@0.1.7-rc.2` | `lib/types/agent.d.ts:41` | `followup(input: UserMessage): void;` |
| `@deepseek-ai/dsh-agent-loop@0.1.7-rc.2` | `lib/types/index.d.ts:151` | `createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;` |
| `@deepseek-ai/dsh-agent-loop-testkit@0.1.7-rc.2` | `lib/types/index.d.ts:22` | `create(id: SessionId, options?: AgentOptions, meta?: Pick<SessionHeader, 'cwd'>): Promise<Agent>;` |
| **工作区（REPO）** | `packages/core/agent-loop/src/index.ts:589` | `create(id: SessionId, options: AgentOptions = {}, meta: … = {}): Agent {` —— **同步返回 `Agent`** |

**结论：`followup` 没有改名、没有搬走**（`Agent` 上就在，发布线与工作区同形）。分歧只在 `create()`
由同步变异步。因此适配是**在 9 个调用点补 `await`**，不重写调用形态；发布线上**没有**"同步 create"
这个等价能力可退，也不该伪造一个。这条**不需要**"功能在发布线上不可用"的判定。

### 2.5 **【本轮实测】** 一处必须小心的地方：`Session.events` 的"一次读一个快照"语义

工作区的 `get events()` 是**缓存快照**（`packages/core/session/src/index.ts:550-562`：
`this.eventsSnapshot ??= Object.freeze([...this.log])`），同一 handler 内多次读**返回同一数组**。
`snapshotEvents()` 是**方法**，每次调用**新建**一个冻结快照
（`An immutable snapshot … A full current snapshot is reused until the next append`）。

因此前移**不是**机械替换：本包把每个 handler 里的多处 `session.events` 收敛为**一次**
`const events = session.snapshotEvents()` 并复用，才能保住"同一 handler 内所有读取看到同一日志状态"
这条原有语义（`src/checkpoints.ts:218-220`、`:310-312`、`src/index.ts:296-298` 都带这条注释）。
逐处替换而不收敛，会在日志于 handler 中途增长时让早先读到的长度与随后读到的内容不一致。
另外三条线把 `snapshotEvents` 标为 `@deprecated`（新调用被禁），但它的返回类型与语义就是本包需要的那个；
已发布的**非弃用**替代只有 `session.surface`（只有序号，无事件），因此本包只能用弃用方法，
并把这件事记在 R10。

### 2.6 前移改动表（文件:行 → 旧 → 新）

| # | 文件:行 | 旧 | 新 |
|---|---|---|---|
| 1 | `src/checkpoints.ts:218`（pre-execute） | `const slice = openTurn(session.events)` | `const events = session.snapshotEvents()` 后 `openTurn(events)` |
| 2 | `src/checkpoints.ts:228` | `step: currentStep(session.events)` | `step: currentStep(events)` |
| 3 | `src/checkpoints.ts:234` | `requiresHeld(guard, session.events)` | `requiresHeld(guard, events)` |
| 4 | `src/checkpoints.ts:307`（post-execute） | `openTurn(session.events)` | `const events = session.snapshotEvents()` 后 `openTurn(events)` |
| 5 | `src/checkpoints.ts:319` | `seq: session.events.length` | `seq: events.length` |
| 6 | `src/checkpoints.ts:324` | `state.reminded.set(…, session.events.length)` | `… events.length` |
| 7 | `src/checkpoints.ts:329` | `step: currentStep(session.events)` | `step: currentStep(events)` |
| 8 | `src/checkpoints.ts:418`（turn-stopping） | `openTurn(session.events)` | `openTurn(session.snapshotEvents())` |
| 9 | `src/index.ts:272`（pre-step） | `recallText(session.events, …)` | `const events = session.snapshotEvents()` 后 `recallText(events, …)` |
| 10 | `src/index.ts:290` | `exposureClock.deltas(session, session.events, injected)` | `… deltas(session, events, injected)` |
| 11 | `src/index.ts:371` | `session.events.length + 1` | `events.length + 1` |
| 12 | `src/invariant.ts:283` | `for (const event of session.events) validate(event, fail)` | `… session.snapshotEvents() …` |
| 13 | `src/index.ts:200` | `source: { kind: 'plugin', plugin: name }` | `source: OikonomiaEyeSource = { kind: 'oikonomia-eye', … }`（含 `form`/`summary`/`checkpoint`/`lexicon`/`entries`/`textSha256_16` 等字段） |
| 14 | `src/index.ts:146-149` | `foreignReminders` 判 `kind === 'plugin'` | 新增 `HARNESS_OWNED_SOURCE_KINDS = new Set(['user','model','tool','system-prompt'])`，判"kind 不在该集合内" |
| 15 | `src/index.ts:34` | `import { recordRound } from './ledger.ts'` | `import { recordRound, textDigest } from './ledger.ts'` |
| 16 | `tests/support/mock-adapter.ts:18` | `import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'` | `import { LlmAdapter } from '@deepseek-ai/dsh-llm'` + `import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'` |
| 17 | `tests/support/mock-adapter.ts:47` | `const callId = CallId(rawCallId)` | `const callId = ToolCallId(rawCallId)` |
| 18 | `examples/fixtures/oikonomia-eye/oikonomia-eye-fixture.ts:10` | `import { CallId, LlmAdapter, … } from '@deepseek-ai/dsh-llm'` | 拆成 `LlmAdapter` + `import { ToolC

## R3 —— 判据库数据文件的路径在独立包里要重新定位

**现象**：源包里**根本没有** `entries.yaml` / `shapes.yaml` / 语料。三个路径是**必填配置**（`lexiconPath`/`entriesPath`/`corpusPath`，无默认值）。
唯一真实存在的示例数据在 **`examples/headless-agent/tests/fixtures/checkpoints/oikonomia-eye/`**
（`lexicon.yaml`、`entries.yaml`、`corpus/`、`oikonomia-eye-fixture.ts`、`cordis.yml`），并且 `cordis.yml` 用
`!!js process.env.DSH_OIKONOMIA_EYE_FIXTURES + '/lexicon.yaml'` 这样的**环境变量**寻址（因为组合在临时 cwd 里跑）。

**根因**：数据是**部署输入**，不是包源码；monorepo 把它放在 example 的测试夹具里。

**判据**：抽取后 `composition.spec.ts` 在 `join(root, 'examples/headless-agent/tests/fixtures/checkpoints/oikonomia-eye')`
处找不到文件（该路径由 `fileURLToPath(new URL('../../../../', import.meta.url))` 算出，脱离 monorepo 后必错）。

**处置（本轮已实施）**：三件夹具搬成 `examples/fixtures/oikonomia-eye/`（`lexicon.yaml`、`entries.yaml`、`corpus/方向.md`、
`cordis.yml`、`oikonomia-eye-fixture.ts`）。**三个配置路径仍然必填、没有任何默认值**——沿用原样。
路径改写共四类：

1. `composition.spec.ts` 的仓库根计算：`fileURLToPath(new URL('../../../../', import.meta.url))` →
   `import.meta.dirname` + `dirname()`，于是 `packageRoot` / `fixtureDir` / `binScript` / `tsconfigPath`
   全部按包内路径解析（正是 R3 判据点名的那处必错点）；
2. `cordis.yml` 里插件行的 `name` 改成包名 `dsh-oikonomia-eye`（原来是旧作用域名）；
3. `cordis.yml` 的 `lexiconPath`/`entriesPath`/`corpusPath` **保持** `!!js process.env.DSH_OIKONOMIA_EYE_FIXTURES + '/...'`
   不变 —— 组合在临时 cwd 里跑，环境变量寻址仍然是对的做法；
4. `package.json` 的 `files` 增加 `examples`，使示例数据随包发布。

**仍未解决（不是本轮能解的）**：组装组合里的 `@deepseek-ai/dsh-agent-spine-demo` 在 registry 上的最高 0.1.x 是
`0.1.1-rc.2`（`latest` 甚至是 `0.0.1-rc.1`），与工作区版本不同线；组合 spec 因此报
`oikonomia-eye-fixture (./oikonomia-eye-fixture.ts): failed to import` 与 `agent-spine ... failed to import`。

## R4 —— 生成器（`eval/stamp-entries.mjs`）的路径依赖：**无**；但闸门（`eval/reconcile.mjs`）有

**结论（1）**：`eval/stamp-entries.mjs` 的路径**全部来自 argv**，只用 `node:crypto` 与 `node:fs`，没有 workspace 依赖。
**搬运零改动**，`tests/stamp-entries.spec.ts` 也能自足重放（它用 `import.meta.dirname` 定位 `../eval/stamp-entries.mjs`，
所以**必须保持 `eval/` 与 `tests/` 的相对层级**）。

**结论（2）**：`eval/reconcile.mjs` 有三处机器相关默认值（`DEFAULT_GATE = 'C:/Users/dell/tools/coord/eval/audit_reconcile.py'`、
同层 `venv` 探测、`python3`/`python` 候选）。独立仓库里那个闸门与 venv **都不存在**。

**判据**：`node eval/reconcile.mjs` 在独立仓库里打印"the reconciliation gate is not at …"并以非零退出（脚本已实现"缺失即大声失败，绝不跳过"）。

**处置**：`--gate` / `OIKONOMIA_EYE_GATE` 已支持，保留；默认值改成"无默认、必须显式给"或改指仓库内路径。
`eval/reconcile-snapshot.json` 是该闸门某次运行的产物，**独立仓库里不可重放**（快照没有生成器），要么连夹具一起搬、要么标为"历史快照，不可重放"。

## R5 —— 快照夹具：测试套件大部分**不能**原样重放（本轮最重的风险）

**证据**：7 个 spec 各有一行**仓库内相对路径**导入，脱离 monorepo 后没有等价物：

```
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
```

出现在 `assemble-trim`、`behavior-delta`、`checkpoints`、`ledger`、`real-tools`、`resident`、`shape-injection`。
另外 `tests/fixtures/composition-driver.ts` 依赖 `@deepseek-ai/dsh-app-boot` 与 `@deepseek-ai/dsh-loader-smoke`
（这两个**已发布**，可从 npm 装）。

**自足的两个**：`tests/gate.spec.ts`、`tests/stamp-entries.spec.ts`（只依赖 `src`、`eval` 与 vitest）。

**根因**：mock adapter 是 `packages/core/agent-loop/tests/` 里的**测试源码**，不是已发布的包。

**判据**：抽取后跑 `pnpm run test`，上述 7 个 spec 报 `ERR_MODULE_NOT_FOUND`（指向 `../../../core/...`）。

**处置（作者已裁定：取方案 1 的"包内自带"，并保留全部 7 个 spec）**：mock adapter 已作为**包内测试支持**搬进
`tests/support/mock-adapter.ts`，文件头注明来源（`deepseek-ai/deepseek-harness` 的
`packages/core/agent-loop/tests/mock-adapter.ts`）与搬入时的 `sha256[:16]` = `47dd92a9c9f8fb4c`。
7 个 spec 的导入全部改指 `./support/mock-adapter.ts`，**一个 spec 都没有砍**。

**依赖闭包（实测：这就是全部）**：该文件只 import `@deepseek-ai/dsh-llm`（值：`CallId`、`LlmAdapter`；类型：
`GenerateOptions`、`LlmModelReasoningInfo`、`LlmResolvedModelInfo`、`StreamChunk`）。**没有别的仓库内相对导入**，
因此闭包只多出这一个文件。它另外导出本包 spec 未用到的 `maxTokensResponse` 与 `HangAfter`，一并照搬以免与其上游漂移。
注意：`CallId` 正是上面 R2 里"已发布线没有"的三个符号之一 —— **自带 adapter 解决了"文件不存在"，
但没有解决"符号不存在"**。

以下三个原始选项保留以备追溯：
1. 自建一份 `tests/fixtures/mock-adapter.ts`（把 `MockAdapter`、`textResponse`、`toolCallResponse` 抄成包内夹具）——
   最快，但复制了 3 个导出、要跟上游漂移；
2. 把 mock adapter 提成一个**已发布**的测试支持包（仓库已有 `@deepseek-ai/dsh-agent-loop-testkit` 这个先例），
   然后独立包依赖它——最干净，但要在 monorepo 侧先做；
3. 只搬自足的 spec，其余标注"仅 monorepo 内可跑"——最省事，但**丢掉 7 个 spec 的覆盖**（含真实工具拒绝路径这条组装级证据）。

**【未验证】**：本轮没有实跑任何测试（禁止 `pnpm run *`），上述结论来自 import 语句本身与文件位置，**不是**运行结果。

## R6 —— 端到端探针：没有任何小样本试跑

**现象**：本轮全部结论来自**静态阅读**（`grep`/`cat`/`stat`/`sha256sum`）。没有一个源文件被真正编译过，没有一行测试跑过。
`tsup` 对 `.ts` 后缀导入与 `verbatimModuleSyntax: true` 的行为、`dsh/index.js` 能否被 node 直接 import、
`tsc --noEmit` 在已发布 `.d.ts` 下的结果 —— **全部未经实测**。

**处置（本轮已做完）**：两个具体未知都测了，**结论都是"没问题"**：

1. **`tsup`/esbuild 解析 `.ts` 后缀的相对导入：通过。** `dsh/index.js` 43–44 KB 构建成功，
   产物里的 import 只剩 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、`yaml` 与 `node:` 内建，
   **没有任何残留的 `.ts` specifier**，相对导入已被内联。
2. **`verbatimModuleSyntax: true` 与 `exactOptionalPropertyTypes: true`：都没有新增错误。**
   `typecheck` 的 75 个错误全部归因于下面那条"已发布线缺符号"，没有一个是这两个开关造成的。
   因此源码的 import 写法（含 `import type {}`）在新配置下是安全的。

**唯一没有通过的是 `tsup` 的声明构建**（`dts: true`），它跑在独立 program 上，因此与 typecheck 同步失败。
JS 半边与声明半边现在被分开：`pnpm run build`（默认出声明）失败，`pnpm run build:no-dts`（`DSH_OIKONOMIA_EYE_NO_DTS=1`）成功。
**这不是"关掉类型"，而是让打包验证能在类型阻塞期间进行**；声明仍然是要发的（见 R8），阻塞清掉后默认路径即恢复。

**已知的两个具体未知**：
1. 源码里**所有相对导入都带 `.ts` 后缀**（`import { decide } from './gate.ts'`）。`tsc` 靠 `allowImportingTsExtensions` + `noEmit` 接受它；
   但 `tsup`/esbuild 是否解析它（`resolveExtensions` 是否含 `.ts`）**必须实测**，不能假设。
2. 本 kit 的 `tsconfig.json` 把 `verbatimModuleSyntax` 设成 `true`，而源基座是 `false`；`exactOptionalPropertyTypes` 也没跟上。
   这两条会不会让源报错，**必须实测**。

## R7 —— 源在被改动中（竞态）

**现象**：读取时刻 `2026-10-15T14:30:14Z`，该包有 **12 个 `M` 与 3 个 `??`**（`git status --porcelain` 共 15 行），其中 `src/exposure.ts`（曝光窗口）
是**未跟踪的新文件**、`src/checkpoints.ts` 等在读取前几分钟还在被改（mtime 22:26–22:29）。

**根因**：另一个执行者正在改该包。

**判据**：抽取前重算摘要与 `8126df37d813b93f` / `445d96d25b6ef2a4` 不一致。

**处置（本轮实测：确实又漂了）**：抽取动手前复算，`src/**` 聚合 **仍是 `8126df37d813b93f`**、11 个文件逐字节一致，
`git status` 仍是 15 行 —— 起点干净。**但抽取过程中它又变了两次**：

| 读取时刻（UTC） | `src/**` 聚合 | 变化 |
|---|---|---|
| 14:37:59Z | `8126df37d813b93f` | 与骨架依据一致 |
| 14:47:36Z | `80f5fdc5758706ef` | `src/checkpoints.ts` 新增 owed 交付路径（390 → 439 行） |
| 14:49:34Z | `719cc9433fa8c878` | 同一文件再次改动（末行尾随空格） |

处置：发现漂移后**只重搬了漂移的那两个文件**（`src/checkpoints.ts` 与 `tests/checkpoints.spec.ts`），
转换与其余文件完全一致（只是包名改写），其余 10 个 `src/*.ts` 与 9 个 spec 未动。
**未跟踪的三个 `??` 文件全部搬入**（`src/exposure.ts`、`tests/behavior-delta.spec.ts`、`tests/resident.spec.ts`），逐字节核过。

**诚实结论**：本仓库对应的是 **2026-10-15T14:47–14:49Z 之间的上游状态**，不是一个冻结点。
下游若继续改该包，本仓库要么重搬，要么明确钉住某个 commit（上游该包本身处于未提交状态，钉不住）。

## R8 —— 发布面：`tsup` 的声明构建**会丢掉两处 `declare module`**【本轮已解决】

> **本轮结论：已解决。** 采用**方案 (a)：构建后把 augment 注入 `dsh/index.d.ts`**，
> 由 `scripts/inject-augments.mjs` 实现（源码的 `#augment:emit` 标记区是唯一真源，逐字节复制）。
> 双证在本节末尾 §R8.5：真 tarball 消费者 `import` 本包后读到 `'coordinate/round'`（typecheck exit 0）；
> 同一消费者、同一段类型使用，把 augment 撤掉后**报 8 条错误**（含 `TS2322: Type '"coordinate/round"' is not
> assignable to type 'keyof SessionEventMap'`）。生成步骤连跑两次 `dsh/index.d.ts` sha256 相同。
> 下面是问题本身与被方案 (a) 取代的旧判断，保留以便追溯。

**现象（实测）**：源码已能编译（`typecheck` 0 错）后，`pnpm run build`（`dts: true`）**成功**，
产出 `dsh/index.d.ts` 3,474 B 与 `dsh/invariant.d.ts` 633 B。但：

**现象（实测）**：源码已能编译（`typecheck` 0 错）后，`pnpm run build`（`dts: true`）**成功**，
产出 `dsh/index.d.ts` 3,474 B 与 `dsh/invariant.d.ts` 633 B。但：

```
$ grep -rn "declare module" dsh/*.d.ts
（无输出）
$ grep -c "MessageSourceMap\|SessionEventMap\|coordinate/round" dsh/index.d.ts
0
```

**根因**：`tsup` 的声明构建把整个程序树摇到只剩"包根可导出的符号"。`src/types.ts` 是**纯类型模块**
（仓库约定：`src/types.ts` 只放类型、不放运行时代码），它对包根的导出贡献为**零**，因此被整个裁掉 ——
连带 `declare module '@deepseek-ai/dsh-llm'` 与 `declare module '@deepseek-ai/dsh-session/types'`
一起消失。这与 `src/index.ts` 的 `import type { OikonomiaEyeSource }` 无关：类型导入同样被擦除，
`dsh/index.d.ts` 里连 `OikonomiaEyeSource` 这个名字都没有。

**对照实测**：`tsc` 的逐文件声明输出**保留**这两处。

```
$ node node_modules/typescript/bin/tsc --rootDir src --declaration --emitDeclarationOnly --outDir <tmp>
$ grep -rn "declare module" <tmp>
<tmp>/types.d.ts:60:declare module '@deepseek-ai/dsh-llm' {
<tmp>/types.d.ts:366:declare module '@deepseek-ai/dsh-session/types' {
```

**消费方后果（实测，不只是推断）**：在一个 scratch 消费者里装真 tarball，然后读合并键：

```ts
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session/types'
import 'dsh-oikonomia-eye'
export const key: keyof SessionEventMap = 'coordinate/round'
```

| 消费者拿到的声明 | 结果 |
|---|---|
| 真 tarball 里的 `dsh/index.d.ts`（tsup 产物） | **FAIL** `Type '"coordinate/round"' is not assignable to type 'keyof SessionEventMap'` |
| `tsc` 逐文件输出（把 `dsh/` 换成 tsc 产物） | **FAIL**，同一条错误 |
| 消费者自己写的同形 augmentation（对照组） | PASS —— 说明这套机制本身可用，坏的只是"本包没把它交付出去" |
| 把本包的 `types.d.ts` 作为**程序文件**导入（`import './pkgtypes.d.ts'`） | PASS —— 说明 augment **内容**是对的，缺的是"让它进入消费者的程序" |

**结论（三句）**：

1. **tsup 不保留那两处 `declare module`** —— 这条上一轮的悬案，答案是"丢"。
2. **仅仅"发 `.d.ts`"不足以让合并键对消费方可见**：`dsh/index.d.ts` 里没有这两处 augment，
   而即使换成 `tsc` 的逐文件输出，只要消费者是通过**包名**（`exports`）解析到本包，
   augment 也没有生效（实测三次都红）。原因在 `exports` 的 `types` 指向单个文件：
   同目录的 `types.d.ts` 不会因此进入消费者的程序。所以"发声明 + `exports.types` 指一个文件"
   这个组合**交付不了 declaration merging**。
3. **修法方向（本轮未实施，属作者裁定）**：把 `types` 指向一个**会加载 augment 的入口**，
   并让消费者按**类型引用**把它拉进程序 —— 例如单独发布 `dsh/types.d.ts` 子路径、在
   `README` 里要求消费者 `import type {} from 'dsh-oikonomia-eye/types'`，或改成
   `references`/`typesVersions` 形态。这不是"再写一行配置"就能确定的，涉及本包对外的类型契约，
   因此本轮**只报告、不改产品面**。

**当前发布面的实际状态**：`build` 成功、`dsh/index.d.ts` 与 `dsh/invariant.d.ts` **都在包里**
（`check-pack` 的 `archive contains dsh/* (dsh/index.d.ts)` 一项会检查它），所以"消费方能解析到本包的
类型"这件事是成立的；**不成立的是"消费方能读到本包往别人 map 里加的键"**。本包自己的 `Config`、
`apply`、`name` 类型在消费者里正常（`check-pack` 的 import 检查与消费者 typecheck 都过）。

### R8.5 **【本轮实测】修法、机制与双证**

**采用的方案：方案 (a) —— 构建后注入，不改产品面以外的任何东西。**

`scripts/inject-augments.mjs` 从 `src/types.ts` 的 `#augment:emit` … `#augment:end` 标记区**逐字节**
取出那两处 `declare module`，追加到 `dsh/index.d.ts`（`exports["."].types` 指向的文件）末尾。
`package.json` 的 `build` 变成 `tsup && node scripts/inject-augments.mjs`；另有 `augment:check`
（`--check`，不写文件）与 `check-pack` 里对真 tarball 的 `declare module` 行检查。

**为什么这样能让 augment 进入消费方程序**：`declare module` 是**程序内**声明，只在"读到了它的那个文件
被拉进程序"时生效；`tsup` 把它剪掉的根因是 `src/types.ts` 对包根导出贡献为零、于是连文件一起被摇掉。
`dsh/index.d.ts` 正好相反：消费者按包名 `import 'dsh-oikonomia-eye'` 时，`exports["."]` 的 `types`
指向它，TypeScript **必然**把它加载进程序，于是这两处 augment 必然进入消费方程序 —— 目标与手段对齐。

**正例（确切命令 + 输出）**：真 tarball 装进 scratch 消费者，`import` 本包后读合并键。

```
$ node <npm-cli> install --no-audit --no-fund --ignore-scripts --no-save \
      dsh-oikonomia-eye-0.1.0.tgz            # 装进 scratch 消费者，30 个包
$ grep -c '^declare module' node_modules/dsh-oikonomia-eye/dsh/index.d.ts
2
$ node <tsc> -p tsconfig.json ; echo $?
0
```

消费者的 `check.ts` **只多一行 `import 'dsh-oikonomia-eye'`**，没有任何别的动作：

```ts
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import 'dsh-oikonomia-eye'

type Keys = keyof SessionEventMap
export const key: Keys = 'coordinate/round'                     // 键存在
type Round = SessionEventMap['coordinate/round']                // 就是本包的 CoordinateRound
export const checkpoint: Round['checkpoint'] = 'pre-step'
export function rounds(events: readonly SessionEvent[]): readonly SessionEvent<'coordinate/round'>[] {
  return events.filter((event): event is SessionEvent<'coordinate/round'> => event.type === 'coordinate/round')
}
import type { MessageSourceMap } from '@deepseek-ai/dsh-llm'
export const source: MessageSourceMap['oikonomia-eye']['kind'] = 'oikonomia-eye'   // 第二个 map 也生效
```

**负例（报错原文）**：同一消费者、同一段 `check.ts`、同一条命令，只把 augment 从 tarball 里撤掉
（解包 → 删掉注入块 → 重新打包；`grep -c '^declare module'` 由 2 变 0），得到 **8 条错误**：

```
check.ts(9,14): error TS2322: Type '"coordinate/round"' is not assignable to type 'keyof SessionEventMap'.
check.ts(12,30): error TS2339: Property 'coordinate/round' does not exist on type 'SessionEventMap'.
check.ts(16,80): error TS2344: Type '"coordinate/round"' does not satisfy the constraint 'keyof SessionEventMap'.
check.ts(17,42): error TS2677: A type predicate's type must be assignable to its parameter's type.
  Type 'unknown' is not assignable to type 'SessionEvent'.
check.ts(17,55): error TS2344: Type '"coordinate/round"' does not satisfy the constraint 'keyof SessionEventMap'.
check.ts(17,78): error TS2367: This comparison appears to be unintentional because the types
  '"turn/start" | … | "session/end-seed"' and '"coordinate/round"' have no overlap.
check.ts(22,39): error TS2339: Property 'oikonomia-eye' does not exist on type 'MessageSourceMap'.
```

这条检查能红，不是"看起来对"：正例与负例的差别只有那两处 `declare module`。

**另一个负例（更粗的形态）**：`build:no-dts`（不产声明）时，消费者报**同样的 8 条**。
证据价值有限，如实记下它证明了什么：消费者手里若有旧版本（含 `dsh/index.js` 但无 `dsh/index.d.ts`），
类型仍解析到那个旧 `dsh/index.d.ts`；两者清一色报"键不存在"，与"缺 augment"同因同果。

**幂等（两次 sha）**：`pnpm run build` 连跑两次（A、B），四个产物 sha256 逐字节相同：

| 产物 | 两次 build 的 sha256 |
|---|---|
| `dsh/index.d.ts` | `9a2faa3966f795f822f3c3a66c5ed4311615ab4553313fbc36cd2c8829978d6f` |
| `dsh/invariant.d.ts` | `1879efbb6a9f1919acbcde0e1746c0ded88eb3098108cc00d540fab6314a5c06` |
| `dsh/index.js` | `b919a2eacb1cb5a2705a14fc3c2ddc4f26394ca41b9968fdcbb9a24747c24a88` |
| `dsh/index.js.map` | `4409a0f03713cc611de1c396fad2732b37395233a975dccc1fb0cf49717d3986` |

注入脚本自身另连跑两次（第 3、4 次）不再改写文件（打印 `already carries 2 declare module block(s)`），
sha 不变；`--check` 判等成立（exit 0）。**幂等的机理**：脚本计算的是"给定现有文件应有的字节"这个纯函数，
不复用上一次的输出。

**边界（如实）**：只 `import 'dsh-oikonomia-eye/invariant'`、从不 `import` 包根时，消费者**读不到**这两个键
（实测 1 条 `TS2322`）。`invariant.d.ts` 里没有 `OikonomiaEyeSource`/`CoordinateRound` 的声明，把同一段
augment 复制进去会引入未定义名，因此**只注入包根**。组合里挂本包时加载的是包根，正常部署不受影响。

**结论**：R8 **已解决**，方案 (a)，双证齐全，并已固化成两道闸门（`build` 里的注入步骤 + `check-pack`
对真 tarball 的 `declare module` 检查）。

## R9 —— 授权与命名：仓库名**已由作者确认**

**现象（历史）**：本 kit 的 `package.json` 里 `repository`/`homepage`/`bugs` 曾写作
`https://github.com/Bingtang1019/dsh-oikonomia-eye.git`，并标为"owner 占位值、作者待确认"；
而源包 `repository.directory` 指向 `deepseek-ai/deepseek-harness`。

**处置（作者本轮裁定：定稿）**：仓库名 **`Bingtang1019/dsh-oikonomia-eye` 已确认**，
`package.json` 的 `repository`/`homepage`/`bugs` 即最终值，**去掉了"待作者确认"字样**；
`README.md` 里那节「发布前必须确认的一项」已改为「仓库归属」的定稿陈述。三项确切现状见本节末表。
`@deepseek-ai/*` 的作用域名**仍然不使用**（本包无作用域）。

| 字段 | 定稿值 |
|---|---|
| `repository.url` | `git+https://github.com/Bingtang1019/dsh-oikonomia-eye.git` |
| `repository.type` | `git` |
| `homepage` | `https://github.com/Bingtang1019/dsh-oikonomia-eye#readme` |
| `bugs.url` | `https://github.com/Bingtang1019/dsh-oikonomia-eye/issues` |

**仍未验证的一项**：本机**没有**跑任何 `git` 网络命令（硬约束），因此"该远端仓库存在、且 `bugs` 指向
可用的 issues 页"这件事**未经网络核实**；本节仅记录作者裁定与仓库内的定稿值。


## R10 —— 前移之后的未决项（避免被当成已验证）

| 未做 / 未决 | 说明 |
|---|---|
| **declaration merging 对消费方可见** | **【本轮已解决】** 见 R8.5：方案 (a)，构建后由 `scripts/inject-augments.mjs` 把 `src/types.ts` 的标记区注入 `dsh/index.d.ts`；正例 typecheck exit 0、负例 8 条错误、注入步骤幂等。**残留边界**（不是未决项，是已知且已记录的形态）：只 `import` 本包 `/invariant` 子路径、从不 `import` 包根时读不到这两个键。 |
| **`Session.snapshotEvents()` 是弃用 API** | 三条线都把它标为 `@deprecated`（新调用被禁），但它是唯一等价替换（`session.surface` 只给序号，不是日志）。需要上游做的是**给出一个非弃用的"读日志快照"入口**，否则本包只能吃这个弃用警告。 |
| **`foreignReminders` 的语义降级** | 发布线取消了共享的 `kind: 'plugin'`，改判"kind 不属于 `user/model/tool/system-prompt`"只是近似。需要上游做的是**给出一个"这条消息是哪个插件产的"的可判定入口**，或把生产者身份做成可枚举的。 |
| **`checkpoints.spec.ts` 的"数别人的提醒"用例** | **仍红 1 例**（77 例里唯一的功能回归），**本轮复跑仍红**：`tests/checkpoints.spec.ts:339` 的 `expect(reminded?.data.duplicateReminders).toBe(1)` 得到 `0`（`AssertionError: expected +0 to be 1`）。原因不是 kind：本包的 `post-execute` 监听器**先于**宿主追加的监听器进入瀑布**下游**（`const downstream = await next()` 之后才数 `downstream.additionalContexts`），因此同批次里"后来者"追加的上下文它**看不到**。实测两种注册顺序都得到 `duplicateReminders = 0`。需要上游/作者裁定的是**这条读数的定义**：如果它要数"同一批次里所有别的插件追加的提醒"，就得改本包进入瀑布的顺序（`next()` 之后才追加、之前才数），那是产品面改动。 |
| **组装组合 spec（`composition.spec.ts`）** | **仍红 1 例**（**本轮复跑仍红**），且**与类型无关**：组合里的 `@deepseek-ai/dsh-agent-spine-demo` 在 registry 上只到 `0.1.2-alpha.2`（`latest` 是 `0.0.1-rc.1`、`next` 是 `0.1.1-rc.2`），低于本包 peer 区间下界 `0.1.2-rc.1`，因此该行 `failed to import`，组合里起不来 agent（`fixture turn requires exactly one top-level agent, found 0`）。顺带修好的一项：本包夹具 `oikonomia-eye-fixture.ts` 原来也因 `CallId` 而 `failed to import`，前移轮改成 `ToolCallId` 后它的状态由 `failed to import` 变为 `pending (waiting for services: llm, tools)`（本轮复跑仍是这个 pending 状态）。需要上游做的是**把 agent-spine 发到区间内**。 |
| **`examples/` 不在 lint 范围内** | `pnpm run lint` 是 `eslint src tests`（通过，0 error）。单独跑 `eslint src tests examples` 会报 `examples/fixtures/oikonomia-eye/oikonomia-eye-fixture.ts:41` 的 `_options is defined but never used` —— 既有问题，未动。 |
| **`forks` 池在本机跑不起来** | 本机 `vitest` 默认池（`forks`）**静默退出**（只打印一行 `RUN`，exit 1，不跑任何用例）。本轮全部测试数字都是 `--pool=threads` 下的结果。这是**本机环境**问题（子进程 spawn 被拦），不是包的问题；`package.json` 的 `test` 脚本未改。 |
| **装进真实 DSH profile 并重启** | 仍未做：没有可用 profile，也没有运行 `dsh`。做到的是"真 tarball 装进临时消费者并按包名 import"（`check-pack` 第 7 项）与"真 tarball 装进消费者后按包名读合并键"（R8.5 正例）。 |
| **`dsh-compat` CI leg 里"真 import 一次"** | 仍未加；另外 CI 里的 `typecheck`/`test` 两步现在是**应当全绿只剩 2 例**，加 import 断言前需要先决定那 2 例怎么记（见上两行）。本轮新增的两道闸门都在 `build` 与 `check-pack` 里，未改 CI workflow。 |
| **CI workflow 的远端真实执行** | 未做：`actionlint` 未跑，GitHub Actions 未跑。 |
| **`README.zh.md` 双语侧 / `skills/` 与 `docs/` 目录** | 仍未搬/仍为空位（`files` 里列了不存在的目录，npm 会跳过）。 |
| **注入脚本的语法扫描器是手写的** | `scripts/inject-augments.mjs` 用一个小扫描器定位 `declare module` 块（跳过字符串、模板串与注释）。它只服务"从这个标记区取块"这一件事，不解析完整 TypeScript；标记区里若出现本扫描器不认识的语法（例如块内的正则字面量含 `{`/`}`），块边界可能算错。当前两处块内只有接口与对象字面量，实测取出的块与 `src/types.ts` 一致。 |
| 任何 `git` 网络命令 / `commit` / `push` | 硬约束禁止，**本轮一次都没有跑**。 |
| 修改 REPO 任何文件 | 硬约束禁止；全程只读（`read`/`grep`/`git status`/`git log`）。 |

## 已实测通过的部分（本轮真的跑过）

| 检查 | 结果 |
|---|---|
| `pnpm install`（离线优先：`--offline` 失败于缺 mirror metadata，回落 registry） | 成功，244 + 64 个包；**TLS 未被中间人拦截**（registry 证书是真实 DigiCert 链，`authorized: true`），因此**不需要** `--cafile` |
| `pnpm-lock.yaml` 生成 + `pnpm install --frozen-lockfile` | 通过（R10 的 CI 首次失败已消除）；29 个声明依赖全部在锁文件里 |
| `pnpm run peers:assert`（8 个版本 × 接受/拒绝） | 8/8 与预期一致；7 条 dsh peer 确认共用同一条区间链 |
| 下界导出核验（`0.1.2-rc.1` / `0.2.0-rc.2`，9 个 tarball，按各包 root types 入口走 export 图） | 15/18 符号可达；`CallId`、`Session.events` 全线缺失，`'plugin'` 只在下界有 |
| `pnpm run lint`（`eslint src tests`） | **通过，0 error**（修了两处真错误：`ledger.spec.ts` 的 type-only import；`guards.ts` 的 `no-useless-escape` 按"保持源码原样"处理，在 eslint 配置里带理由关闭） |
| `pnpm run test`（vitest） | **77 用例：32 过 / 45 挂**，10 个 spec 文件里 2 个全过（`gate` 14/14、`stamp-entries` 2/2） |
| `pnpm run build:no-dts`（tsup，JS 半边） | 成功：`dsh/index.js` 44,833 B + `dsh/invariant.js` 7,804 B（+ 2 个 sourcemap） |
| `dsh/index.js` 的 external 核 | 只有 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、`yaml`、`node:*`；**零内联 cordis**，零残留 `.ts` specifier，零内联 schemastery 实现 |
| `import('./dsh/index.js')` | 成功，导出 `Config, apply, name`，`name = "oikonomia-eye"`；`invariant.js` 导出 `apply, inject, name`（`inject = ['invariants']`） |
| `npm pack` + `check-pack` 对**真实 tarball** | **8 项全 PASS，exit 0**，含"装进临时消费者并按包名 import 成功"；tarball 18 个文件 / 72.7 kB |
| `check-pack` 对**包根**（`--dry-run` 文件表） | 7 项全 PASS，exit 0 |
| 全仓零写入确认 | 交付前后 `git status --porcelain`（包范围）同为 15 → 16 行，增量全部来自**另一个执行者**改的那两个文件；本会话未写入 REPO 任何路径 |

**上面这张表是上一轮（抽取轮）的实测记录，数字未被本轮改写。**
（其 `build:no-dts` 一行写的 `dsh/index.js` 44,833 B 是**当轮**的产物大小；本轮加了四条分歧的改动后是 45,613 B。
两轮数字不同是正常的，各自对应各自的源码。）

**轮次标注**：上一轮的表里写着 `test` 32 过 / 45 挂，那个数字是在 **vitest 默认 `forks` 池**下测的；
本机 `forks` 池现在会静默退出（见 R10），本轮改用 `--pool=threads`，得到同样的 32 / 45 基线，
因此两轮的基线是可比的。

**上一轮修掉的两个 kit 内缺陷**（都不在 REPO 里，都在 kit 目录内）：

1. `check-pack` 与 `prepack` 互相递归（`check-pack` 用 `npm pack --dry-run` 列文件，而它自己触发 `prepack`）——用 `DSH_CHECK_PACK_RUNNING` 环境变量标记打断，且 `npm pack --json` 的生命周期横幅会混进 stdout，故 JSON 改为定位解析而非假定从 0 字节开始；
2. `files` 与 `check-pack` 要求一个从不产生的 `dist/`（模板残留）——已收敛为只要求 `dsh/`。

## 本轮（前移轮）已实测通过的部分

全部在 **kit 目录**内执行；REPO 全程只读。日期 2026-10-15；Node `v24.21.0`；依赖钉在 `0.1.7-rc.2` 线。

| 检查 | 结果 |
|---|---|
| 发布线证据提取（3 条线 × 7 个包的真 tarball，按各包 `exports["."].types` 读 `.d.ts`） | 四条分歧全部定位到"包名 + 版本 + 文件:行 + 原文"，见 §2.4 |
| `pnpm run typecheck`（`tsc --noEmit`） | **0 错**（前移前 75 错） |
| `pnpm run lint`（`eslint src tests`） | **通过，0 error 0 warning**；`eslint src tests examples` 会多报 1 个既有 `_options` 未用（见 R10），**未改** |
| `pnpm run test`（`vitest run --pool=threads`） | **77 用例：75 过 / 2 挂**（前移前 32 过 / 45 挂）。逐条失败见 R10 表末两行 |
| `pnpm run peers:assert` | 8/8 与预期一致（7 条 dsh peer 共用同一条区间链） |
| `pnpm run build`（tsup，**含 `dts: true`**） | **首次通过**：`dsh/index.js` 45,613 B、`dsh/invariant.js` 7,814 B、`dsh/index.js.map` 141,338 B、`dsh/invariant.js.map` 22,233 B、`dsh/index.d.ts` 3,474 B、`dsh/invariant.d.ts` 633 B |
| `tsup` 是否保留两处 `declare module` | **不保留**（R8 的答案）。`tsc --declaration` 逐文件输出保留 |
| `npm pack` + `check-pack` 对**真 tarball** | **7 项全 PASS，exit 0**，含"装进临时消费者并按包名 import 成功（`exports: Config,apply,name`）" |
| 真 tarball 的尺寸与摘要 | 20 个文件 / **80,930 B**；`sha256 = 73caf46160594bdfd4957db41197f8ddc899f417a1fcb1240eaa67a74e43f3ef`；`sha1 = 14cfaf55bdf0ae13d605fe470e26d735d136d0b7`；含 `dsh/index.d.ts`、`dsh/invariant.d.ts`、`cordis.patch.yml`（摘要随文档字节变化；这是与本节内容一致的版本） |
| scratch 消费者的 `node` import | 成功（`check-pack` 第 7 项）；消费者 **typecheck** 也能解析本包 `Config`/`apply`/`name` |
| scratch 消费者读合并键 `'coordinate/round'` | **FAIL**（三种声明交付形态都试了），见 R8 |
| 组合 spec 的夹具插件 | 修 `CallId` → `ToolCallId` 后，状态从 `failed to import` 变为 `pending (waiting for services: llm, tools)` —— 该夹具本身已可加载 |
| REPO 零写入 | 全程只读（`read` / `grep` / `git status` / `git log`）；**未 `commit`、未 `push`、未跑任何 git 网络命令** |

## 本轮（R8 轮）已实测通过的部分

全部在 **kit 目录**内执行；REPO 全程只读。日期 2026-10-16；Node `v24.21.0`；依赖钉在 `0.1.7-rc.2` 线。
本机 `node`/`npm`/`pnpm` 不在 PATH 上（`E:\node-v24.18.1-win-x64` 只有 shim 没有 `node.exe`），
因此全部命令用 `_tools/node.exe` 驱动 npm/pnpm/tsc 的 `*-cli.js`；`npm pack` 的 `prepack` 走
`cmd.exe`，所以跑它时必须把 `node.exe` 放进 PATH，否则 `prepack` 里的 `node scripts/check-pack.mjs`
找不到 `node`（第一次跑就是这个失败，记下来以免当成产品缺陷）。

| 检查 | 结果 |
|---|---|
| `typecheck`（`tsc --noEmit`） | **0 错** |
| `lint`（`eslint src tests`） | **通过，0 error** |
| `test`（`vitest run --pool=threads`） | **77 用例：75 过 / 2 挂**，与前移轮同基线；**仍红 2 例逐条**见 R10 表（`checkpoints.spec.ts:339` 得 `0` 而非 `1`；`composition.spec.ts` 的 `agent-spine` 起不来） |
| `peers:assert` | 8/8 与预期一致（7 条 dsh peer 共用同一条区间链） |
| `build`（`tsup && node scripts/inject-augments.mjs`） | **通过**；DTS `dsh/index.d.ts` 3.39 KB + `dsh/invariant.d.ts` 633 B；注入步骤报 `updated with 2 declare module block(s)` |
| 注入脚本幂等（两次 `build`，四个产物） | **逐字节相同**：`dsh/index.d.ts` `9a2faa3966f795f822f3c3a66c5ed4311615ab4553313fbc36cd2c8829978d6f`、`dsh/invariant.d.ts` `1879efbb6a9f1919acbcde0e1746c0ded88eb3098108cc00d540fab6314a5c06`、`dsh/index.js` `b919a2eacb1cb5a2705a14fc3c2ddc4f26394ca41b9968fdcbb9a24747c24a88`、`dsh/index.js.map` `4409a0f03713cc611de1c396fad2732b37395233a975dccc1fb0cf49717d3986` |
| 注入脚本幂等（连跑 25 次） | `dsh/index.d.ts` sha 不变 |
| 注入脚本的失败模式（4 例，在临时副本上跑） | 无标记 / 区域无块 / 标记不配对 → 均 exit 2 且**大声报错**；`--check` 检出漂移 → exit 1 |
| `check-pack` 对**真 tarball** | **8 项全 PASS，exit 0**（比上一轮多一项：`dsh/index.d.ts carries the declaration merging (@deepseek-ai/dsh-llm, @deepseek-ai/dsh-session/types)`） |
| `check-pack` 对**包根** | **8 项全 PASS，exit 0** |
| **正例**：scratch 消费者 `npm install <真 tarball>` 后 `import 'dsh-oikonomia-eye'` 读合并键 | **typecheck exit 0**（4 处真实类型使用：`keyof SessionEventMap` 赋值、`SessionEventMap['coordinate/round']` 取字段、`SessionEvent<'coordinate/round'>` 作类型谓词、`MessageSourceMap['oikonomia-eye']`） |
| **负例**：同一消费者、同一 `check.ts`，tarball 里撤掉注入块 | **typecheck exit 2，8 条错误**（原文见 §R8.5） |
| **负例 2**：消费者只 `import 'dsh-oikonomia-eye/invariant'` | **1 条 `TS2322`** —— 已知边界，见 R8.5 |
| 真 tarball 的尺寸与摘要 | 20 个文件 / **86,786 B**；`sha256 = 106e2ffb4380a8404f51d3c4794c80a2f7f63cd0e692e5cbf9ea012bb9249286`；`sha1 = ff4868a0b7829f268777900ad3ba6dbdae9941cc`；`npm` 报 `shasum = ff4868a0b7829f268777900ad3ba6dbdae9941cc`（与 sha1 一致）。摘要随 `README`/`RISKS` 字节变化 |
| `package.json` 的 `repository`/`homepage`/`bugs` | 定稿，无"待作者确认"字样；三项值见 R9 表 |
| REPO 零写入 | 本轮开始与结束都只跑只读 `git status`/`git log`；`packages/experimental/oikonomia-eye` 仍是 **11 个 `M` + 3 个 `??`**（共 15 行，与前一轮同数），HEAD 仍是 `8291ac51a1b32717f050dd694d24fec76ae4d39e`（未变）；**未 `commit`、未 `push`、未跑任何 git 网络命令** |

## R11 —— 首次发布：新包名的 `0.0.0-stage` 占位版本会被误读成"待批准"

**事实（registry 原文，2026-10-15）**：

| 项 | 值 |
|---|---|
| 包创建 | `time.created = 2026-10-15T20:51:22.083Z`，版本 `0.0.0-stage`（`stub: true`，`description: "Temporary package placeholder for staged publishing"`，2 个文件 / 339 B） |
| 真版本落地 | `time["0.1.0"] = 2026-10-15T20:52:19.728Z` ⇒ **占位后约 57 秒** |
| 真版本元数据 | `_npmVersion = 11.16.0`、`_nodeVersion = 24.21.0`、`_npmUser.name = bingtang1019`、`dist.shasum = dcf181d024593aeee3e8bbde9f63ed9785a6cd04`（与本地 tarball 逐字节相同） |

**陷阱**：在占位版本出现、真版本尚未落地的这段窗口里查 registry，会读到"包已存在但没有你的版本"，而 `GET /-/stage` 同时返回 `{"items":[],"total":0}`。这两个读数合起来**看起来像**"npm 把这次发布转成了暂存发布、需要账号拥有者批准"。本 kit 的首次发布就是这样被误判的：执行者在 `20:51:23` 查了一次（**比真版本早 56 秒**）就把结论定成"待作者批准"，并据此要求作者去网页批准——**那个闸门并不存在**。

**判据（下次怎么避免）**：

- 首发之后**至少等 60 秒再复查** `dist-tags` 与 `versions`；占位期间不要下"需要批准"的结论。
- `GET /-/stage` 为**空**既不能证明"没有暂存"，也不能证明"需要批准"——它不是发布状态的判据。
- `_nodeVersion` 是"这次上传由哪条工具链执行"的硬证据：本 kit 用 `node v24.21.0` + `npm 11.16.0`；作者本机的 node 是 `24.18.1`，若由作者本机发布，该字段不会是这个值。
- **发布权在 token 里，不在网页的按钮上**：一把有发布权的 token 执行一条 `npm publish` 即完成上传，中间没有任何人工闸门。因此发布用 token 必须限权、只用于发布、用完即吊销。

**发布行为的正式记录**：`dsh-oikonomia-eye@0.1.0` 由执行者用作者提供的 token 发布（`_npmUser = bingtang1019`），发布的 tarball 与本地 kit 产物 **`cmp -s` 逐字节相同**，`dist-tags.latest = 0.1.0`。作者侧不需要任何操作。

