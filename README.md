# dsh-oikonomia-eye

**The Eye of Oikonomia** 是一个 DSH（DeepSeek Harness）插件：在循环提出一步的那一刻，把该任务的**形状词表**召回的判据注入进来，并在轮次运行期间执行那些带有机器可检条件的判据。它用词表的触发词匹配"本步 claim 的输入批次 + 会话日志尾部"的文本，把每个触发形状的判据文本作为一条 user 角色块挂到 `agent/pre-step` 上。带 guard 的条目还在另外三个检查点行动：`tools/pre-execute` 在条件不成立时拒绝被覆盖的调用，`tools/post-execute` 在被计数的动作越过上限后软提醒一次，`agent/turn-stopping` 在提醒未被采纳时引导一步有上限的对账。匹配与执行全程在本进程内完成，只读本地词表、本地条目表与本地语料：**默认模式不发起模型请求，也不发起网络请求**。

计划书留白的一处读法已由作者于 2026-10-15 裁定：`requires` 条件在**整个会话**内求值，因此前一轮跑过的读操作仍然满足它（见[已知限制](#已知限制)）。

> **本仓库当前状态：源码、测试与构建产物已落地；插件已能对着已发布的 DSH 线编译、构建并跑测试。**
> `src/`（11 个文件，含未跟踪的 `exposure.ts`）、`tests/`（10 个 spec + `support/mock-adapter.ts`）、`eval/`、
> `examples/fixtures/oikonomia-eye/`（示例部署数据）与构建产物 `dsh/` 都已在位。
> **本轮（前移轮）实测**：`typecheck` **0 错**（此前 75）、`test` **75 过 / 2 挂**（此前 32 过 / 45 挂）、
> `lint` 与 `peers:assert` 通过、`build` **含声明**首次通过、`check-pack` 对真 tarball 全 PASS。
> 源码原本写在本仓旧基线 `0.1.1-rc.2` 上，本轮把四条 API 分歧前移到已发布线；**前移只在包内做，不改判据语义**。
> **仍然未做到的一项**是 declaration merging 对消费方可见（`tsup` 会丢掉两处 `declare module`，见
> [RISKS.md](RISKS.md) R8）。第二条残留是 2 个失败用例（1 个是读数定义问题、1 个是上游 `agent-spine` 未发布到区间内），
> 见 [RISKS.md](RISKS.md) R10。四条分歧的发布线证据见[与 monorepo 源码面的一致性说明](#与-monorepo-源码面的一致性说明)。
> 依赖勘定见 [DEPENDENCIES.md](DEPENDENCIES.md)。

---

## 这是什么

- **形状词表模式（shape mode）**：词表是一组形状，每个形状有 `id` 与非空 `trigger` 列表。查询文本命中形状的至少一个**窄**触发词时，该形状**触发**；只被宽词命中的形状被抑制并如实上报，而不是注入。
- **判据库**：条目表是判据文本的真源。每条判据带自己的内容哈希 `sha256_16`，加载期校验：文本被改过而戳没重打，则**加载期抛错**，而不是悄悄改变判据的含义。
- **三个中轮检查点 + 一个作者命令**：拒绝（deny）、软提醒（reminder）、对账（reconcile），以及作者录入命令（默认 `/eye`）。
- **每轮留痕**：每轮写一条 `coordinate/round` 事件到会话日志，记录注入/命中/漏配/开销，以及（见下）曝光窗口与行为距离读法。

本包只实现形状词表模式：没有嵌入、没有分面位置、没有衰减调度，`axes: 'off'` 是轮次记录唯一可能的状态。

## 安装与挂载

本包以 **DSH bundle 层**的形式挂载。`package.json` 自己声明了这件事：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml` 把插件插入 profile：

```yaml
- insert:
    - id: oikonomia-eye
      name: 'dsh-oikonomia-eye'
```

`exports` 暴露两个入口，插件本体是纯 JS（`dsh/index.js`），由包根导出：

| 入口 | 文件 |
|---|---|
| `.` | `./dsh/index.js` + 声明 `./dsh/index.d.ts` |
| `./invariant` | `./dsh/invariant.js` + 声明 `./dsh/invariant.d.ts` |
| `./src/*` | `./src/*`（源码平面，供本仓库自己的测试与工具解析） |
| `./package.json` | `./package.json` |

**没有 `./client` 入口。** 本包没有 UI 半边：早先的骨架里有一条指向 `dsh/client.js` 的 `exports["./client"]`，
但该文件从不产生，保留它只会让 `import 'dsh-oikonomia-eye/client'` 以难懂的方式失败，因此已删除。
同理，`files` 里也不再列 `dist/`：本包不发 CLI、不发 client，插件半边就是全部构建产物。

挂载步骤与已发布的既有插件仓库一致（本包与其同形）：

1. 让本包可被解析：把它作为依赖装进目标 DSH profile 的依赖面（本地开发时是 `link:`，发布后是版本号）。**注意 `auto-install-peers=false`**：peer 依赖不会自动装，DSH 运行时那一侧必须已经具备它们。
2. 把 `dsh-oikonomia-eye` 加进该 profile 的 bundle 列表，使 `cordis.patch.yml` 被应用。也可以按该 profile 的既有做法手动加一条 patch 行：`id: oikonomia-eye`、`name: 'dsh-oikonomia-eye'`。
3. 在组合文件里给这一行 `config`（三个路径必填，见下表）。
4. 重启 / 重载该 profile 并核对：插件加载期会**大声失败**——文件缺失、YAML 不可解析、条目引用未声明的形状、已声明形状没有条目、`sha256_16` 缺失或不符，一律在加载期抛错，而不是把闸门降级成宽松版。

> **【已实测】** 抽取步骤跑通了打包与消费者解析：`npm pack` 产出的 tarball 被 `check-pack` 装进一个临时消费者
> （`npm install --no-save --ignore-scripts <tgz>`），随后 `node` 按包名解析到 `exports["."]` 并成功 import，
> 导出为 `Config, apply, name`（8 项检查全 PASS，见 RISKS.md「已实测通过的部分」）。
> 仍未实测的是**装进一个真实 DSH profile 并重启**这一步：本轮没有可用 profile，也没有跑 `dsh` 本身。

### 部署输入（三个必填路径）

三个路径没有默认值：词表、条目表与语料都是部署输入，给默认值等于凭空发明一份。DSH 组合文件里的一个最小例子：

```yaml
- id: oikonomia-eye
  name: 'dsh-oikonomia-eye'
  config:
    lexiconPath: C:/path/to/shapes.yaml       # required
    entriesPath: C:/path/to/entries.yaml      # required
    corpusPath: C:/path/to/docs               # required
    corpusExtensions: [.md]                   # default
    wideRatio: 0.02                           # default
    minCjkTermLength: 2                       # default
    maxEntries: 3                             # default
    maxBlockChars: 1200                       # default
    queryChars: 4000                          # default
    denyMode: enforce                         # default; `off` registers no pre-execute listener
    maxDenialsPerTurn: 2                      # default
    maxReconcilesPerTurn: 1                   # default
    authorCommand: eye                        # default; command name without the slash
    exposureWindowRounds: 20                  # default; rounds one exposure window counts over
    residentEntriesLimit: 2                   # default; entries the always-present block may carry
    residentCharsLimit: 400                   # default; characters the always-present block may have
```

## 配置项

下表每个字段都标出本包在**哪里消费**它，因此"没有消费者的字段"一眼可见。三个路径没有默认值，其余为表中所述的默认值；`wideRatio` 必须落在 `(0, 1]`。

| 字段 | 含义 | 消费点 |
|---|---|---|
| `lexiconPath` | 形状词表文件：一个带 `shapes` 列表的映射，每个形状有 `id` 与非空 `trigger` 列表。 | `src/index.ts:160` |
| `entriesPath` | 判据条目表：一个带 `entries` 列表的映射，每条有 `id`、`shape`、`text`、`source`、以及该文本的 `sha256_16` 戳，可选 `resident: true` 与 `guard`。改动之后必须重打戳（见下节）。 | `src/index.ts:160` |
| `corpusPath` | 计算词频所用的语料文件或目录。 | `src/index.ts:162` |
| `corpusExtensions` | 目录扫描接受的扩展名（默认 `['.md']`）。 | `src/index.ts:162` |
| `wideRatio` | 触发词的文档频率达到语料该比例即判为宽词（默认 `0.02`，须在 `(0,1]`）。 | `src/index.ts:161`（闸门）与 `:243`（每轮留痕） |
| `minCjkTermLength` | 可保持窄词的最短 CJK 词长（默认 `2`）；更短的 CJK 词一律判宽。 | `src/index.ts:161` |
| `maxEntries` | 单个注入块最多携带的条目数（默认 `3`）。 | `src/index.ts:272` |
| `maxBlockChars` | 单块渲染文本的最大字符数（默认 `1200`）。 | `src/index.ts:272` |
| `queryChars` | 每轮匹配所用召回文本的最大字符数（默认 `4000`）。 | `src/index.ts:231` |
| `denyMode` | `enforce` 在 guard 条件不成立时拒绝被覆盖的调用；`off` 不注册 pre-execute 监听，guard 既不评估也不留痕。 | `src/index.ts:180`（注册）与 `:241`（每轮留痕） |
| `maxDenialsPerTurn` | 一轮允许收到的拒绝次数上限（默认 `2`）；超过后 guard 停止拦截并记 `capped`。 | `src/index.ts:180` |
| `maxReconcilesPerTurn` | 一轮在收束边界允许收到的对账步数上限（默认 `1`）。 | `src/index.ts:180` |
| `authorCommand` | 作者录入命令的名字，不带斜杠（默认 `eye`）。 | `src/index.ts:199` |
| `exposureWindowRounds` | 每轮曝光窗口计数的 pre-step 轮次数（默认 `20`）。 | `src/index.ts:149` 与 `:240` |
| `residentEntriesLimit` | 常驻块最多携带的条目数（默认 `2`）。 | `src/index.ts:173` 与 `:292` |
| `residentCharsLimit` | 常驻块的最大字符数（默认 `400`）。 | `src/index.ts:174` 与 `:292` |

> 表里的行号指**源码修订**（见文末"来源修订"）的 `src/index.ts`。抽取落地后源码行号会变，届时以实际文件为准。

所有路径与所有数值字段都在**插件加载期**校验：文件缺失、YAML 不可解析、条目引用未声明的形状、已声明形状没有条目（因此"命中却无物可注入"的轮次不可能出现）、`sha256_16` 缺失或与自身文本不符、guard 出现 schema 未记录的字段、计数阈值小于 2、deny 条件类型未实现、路径谓词没有声明读取路径的参数、上限小于 1、命令名不符合注册表文法，一律在加载期抛错。

## 判据库与生成器怎么用

判据库是**两份 YAML 加一份语料**：

- **形状词表**（`lexiconPath`）：形状 `id` 与触发词。规则与常量对齐参考闸门 `shape_gate.py`（`shape-gate/1`、宽词比例 `0.02`、单个 CJK 字符永不判窄），包括"宽词不能单独召回形状"这一条。
- **条目表**（`entriesPath`）：判据文本的真源。每条带 `sha256_16`——**文本的内容哈希**。
- **语料**（`corpusPath`）：宽词频率的分母。

### 打戳（`eval/stamp-entries.mjs`）

条目表的改动**必须**跟着重打戳：

```sh
# 写入戳（就地改写，行级；注释、键序与无关行都原样保留）
node eval/stamp-entries.mjs <entries.yaml> [more.yaml ...]

# 只报告，不写文件；有文件待打戳时退出码为 1
node eval/stamp-entries.mjs --check <entries.yaml> [...]
```

退出码：`0` = 全部已打戳（`--check` 时表示"本来就是最新的"），`1` = 有文件需要打戳（仅 `--check`），`2` = 用法或 I/O 错误。

戳的位置是**约定的一部分**：戳紧跟在该条目的 `source:` 行之后（没有 `source:` 则跟在 `text:` 之后）；脚本会把早先布局留下的游离戳**移到**该位置，而不是再写一个，所以跑两遍产生**逐字节相同**的文件。改判据文本、甚至只是挪动一个字段，都会让文件停在"戳不属于"的布局上——`--check` 会一直报该文件，直到把表写回上述布局。

### 判据的形状

条件无法用 `condition: {kind: requires}`（会话内列出的工具已经跑过）表达时，该判据**不能拒绝，只能提醒**——这是当前唯一机器可检的前提类型。范围匹配读取声明的 `fileArgument`：调用没带该参数、或该处不是字符串时不算被覆盖。

### 判别值 `oikonomia-eye` 故意保持不变

抽取时包名从 `@deepseek-ai/dsh-experimental-oikonomia-eye` 改成了 `dsh-oikonomia-eye`，JSDoc 的 `@module` 标签、
不变量断言的包名（`src/invariant.ts` 的 `PACKAGE_NAME`）与测试里的自引用都跟着改了。**唯独 `source.kind: 'oikonomia-eye'` 没有改，这是有意的**：
该判别值是**耐久数据的一部分**，已经写进会话日志的 `user/message` 事件里（它是 `src/types.ts` 往 `MessageSourceMap` 注册的键，也是不变量校验的入口）。
把它改成新包名会让已存在的日志记录变成未知来源，"谁在什么检查点注入了什么"这条审计链就断在这里。
同理，`cordis.patch.yml` 里的 row id 与 `name` 是**加载配置**，与日志里的判别值不是同一个命名空间，改包名不牵动它们。

## 与 monorepo 源码面的一致性说明

**本 kit 面向已发布的 DSH 线；monorepo 里的 `packages/experimental/oikonomia-eye` 面向工作区基线。
两者有意分歧，本文逐条列出分歧点。** 前移只发生在本 kit 内 —— 工作区那份源码一个字都没动。

前移的依据是**从 registry 下载的真 tarball**，按各包 `exports["."].types` 声明的入口读 `.d.ts` 原文；
不按名字猜，也不按"仓库里有"推断"发布线也有"。三条线都查了：`0.1.2-rc.1`（本包 peer 区间下界）、
`0.1.7-rc.2`（本包 devDependencies 钉住的那条）、`0.2.0-rc.2`（0.2 线）。

### 分歧一：读会话日志的方式

| | 工作区（REPO） | 已发布线（三条都有） |
|---|---|---|
| 入口 | `get events(): readonly SessionEvent[]`（`packages/core/session/src/index.ts:559`），**缓存**快照（`:550-562` 的 `this.eventsSnapshot ??= Object.freeze([...this.log])`） | `snapshotEvents(fromSeq?, toSeqExclusive?): readonly SessionEvent[]`（`dsh-session@0.1.7-rc.2` 的 `lib/types/index.d.ts:193`），**每次调用新建**快照 |
| 语义 | 同一 handler 内多次读返回同一数组 | 每次调用得到新的冻结数组 |
| 弃用 | 未弃用 | 三条线都标 `@deprecated Existing logic may remain unmigrated for now, but new calls are prohibited.` |

**本包怎么改的**：把每个 handler 里的多处 `session.events` 收敛为**一次**
`const events = session.snapshotEvents()` 再复用，以保住"同一 handler 内所有读取看到同一日志状态"这条
原有语义。**没有别的等价物可用**：`session.surface`（`SessionSurface`，`lib/types/surface.d.ts:118-125`）
只给 `nodes`（`SessionSeq` 序号数组）与两个 generation 计数，**不是日志**。

**Monorepo 侧要知道什么**：本包吃着一个弃用 API。发布线给"读日志快照"的唯一非弃用入口是
`session.surface`，而它不含事件；因此若上游希望插件不再用弃用面，需要先提供一个非弃用的日志读入口。

### 分歧二：工具调用 id 的品牌函数

| | 工作区（REPO） | 已发布线（三条都有） |
|---|---|---|
| 名字 | `CallId`（`packages/llm/llm/src/brand.ts:31`） | `ToolCallId`（`dsh-llm@0.1.7-rc.2` 的 `lib/types/brand.d.ts:31`） |
| 位置 | 包根（`src/index.ts:35` 的 `export * from './brand.ts'` 把它带到根） | 包根 `export *` 的仍是 `./brand.ts`，**但 brand 里那个名字是 `ToolCallId`** ⇒ 包根没有 `CallId` |
| 用到它的类型 | `ToolCallBlock.id: CallId`（`packages/llm/llm/src/types.ts:81`） | `ToolCallBlock.id: ToolCallId`（`lib/types/types.d.ts:85-86`） |

**本包怎么改的**：显式走子路径并改名 ——
`import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'`。三条线的 `exports` 都有 `"./brand"`，
所以这是"发布线真实存在的 exports 表"下的最小修法，**不需要**在 `package.json` 里额外声明子路径依赖，
也**不需要** `tsconfig` 的 `paths` 映射。

**命中位置**：本包**源码对 `CallId` 零命中**；命中它的是两处测试支持 ——
`tests/support/mock-adapter.ts`（`:18` 导入、`:47` 调用）与
`examples/fixtures/oikonomia-eye/oikonomia-eye-fixture.ts`（`:10` 导入、`:46` 调用）。
后者原先让组合 spec 的夹具报 `failed to import`；改用 `ToolCallId` 后该夹具已可加载。

### 分歧三：消息来源的判别值

| | 工作区（REPO） | 已发布线 |
|---|---|---|
| `MessageSourceMap['plugin']` | 有（`{ kind: 'plugin'; plugin: string } & ContextFormed`） | **`0.1.7-rc.2` / `0.2.0-rc.2` 没有**；`0.1.2-rc.1` 有（`lib/types/message.d.ts:98-101`） |
| 上两条线实际有什么 | — | `user` / `model` / `tool` / `'system-prompt'`（`message.d.ts:101-108`） |
| 发布线的设计声明 | — | `Merge-extensible sum type — each producer declares its own kind in its own module; there is no shared catch-all plugin kind.`（`message.d.ts:92-94`） |

**本包怎么改的**：

1. **插件的来源判别值不变**：`source.kind = 'oikonomia-eye'`（声明在 `src/types.ts:63-67`）。
   这正是发布线要的"每个生产者声明自己的 kind"形态。
2. **那处临时消息自解**：`src/index.ts` 里给 token meter 计价的临时 `user` 消息原本构造
   `{ kind: 'plugin', plugin: name }`。已改成本包自己的 `kind: 'oikonomia-eye'`，并补齐
   `OikonomiaEyeSource` 的字段（`form`/`summary`/`checkpoint`/`lexicon`/`entries`/`textSha256_16` 等）。
   该消息**不进行耐久日志**，只被 meter 计价。
3. **一处真实的能力降级**：`foreignReminders()` 原本统计"别的插件塞进同一批次的提醒"，判据是
   `kind === 'plugin'`。这个共享 kind 在 `0.1.7-rc.2` / `0.2.0-rc.2` 上不存在，因此改为
   "kind 不属于 `user|model|tool|system-prompt` 者即外来"。这是**近似**：发布线上同批次里
   `kind: 'user'` 的消息不再计入。发布线没有给出"这条消息是哪个插件产的"的可判定入口。

### 分歧四：创建 agent 的调用形态

| | 工作区（REPO） | 已发布线（三条都有） |
|---|---|---|
| `agentLoop.create()` | `create(id, options = {}, meta = {}): Agent` —— **同步**（`packages/core/agent-loop/src/index.ts:589`） | `create(id, options?, meta?): Promise<Agent>`（`dsh-agent-loop@0.1.7-rc.2` 的 `lib/types/index.d.ts:135`） |
| `Agent.followup` | `followup(input: UserMessage): void` | `followup(input: UserMessage): void`（`lib/types/agent.d.ts:41`）—— **同名同形，未改名** |

**本包怎么改的**：在 9 个调用点补 `await`。**没有**改成 `createAgent()` 之类的另一条路径，
因为 `followup` 本身在发布线上具备等价能力，这条不存在"功能不可用"。

### 这两份源码的其余差异（不是 API 分歧，但读的时候要知道）

| 项 | 本 kit | monorepo 包 |
|---|---|---|
| 包名 | `dsh-oikonomia-eye`（无作用域） | `@deepseek-ai/dsh-experimental-oikonomia-eye` |
| 依赖来源 | `peerDependencies` + `devDependencies` 的 registry 版本 | 全 `workspace:^` |
| 类型解析 | `node_modules` 里的**已发布** `.d.ts` | 根 `tsconfig.base.json` 的 `paths` → **仓库内 `src`**（源平面） |
| `tsconfig` | 独立（noEmit + strict，`include: ["src","tests"]`），无 `paths`、无 `references` | `extends ../../../tsconfig.base.json` + 11 条 project references |
| 跨包测试源码 | `tests/support/mock-adapter.ts`（包内自带，注明来源与摘要） | `../../../core/agent-loop/tests/mock-adapter.ts`（仓库内相对路径） |
| `examples/fixtures/oikonomia-eye/` | 搬进来的示例部署数据 | 原来在 `examples/headless-agent/tests/fixtures/checkpoints/oikonomia-eye/` |
| `.agents/notes/**`、`README.i18n.yaml`、仓库闸门脚本 | 不搬 | 仓库治理设施 |

**唯一必须保持一致的判别值**是 `source.kind = 'oikonomia-eye'`：它是**耐久数据的一部分**，
已经写进会话日志的 `user/message` 事件里。改名会让已存在的日志记录变成未知来源，审计链就断在这里。
`cordis.patch.yml` 的行 id 与 `name` 是**加载配置**，与日志里的判别值不是同一个命名空间。

## 已知限制

- **【前移轮更新】对着已发布的 DSH 线已经能编译、构建、发声**：`typecheck` 0 错、`test` 77 例里
  75 过、`build`（含声明）通过、`check-pack` 对真 tarball 全 PASS。此前"三者在任何已发布线上都不存在"
  的判断已被本轮实测推翻：`Session.events` 的等价物是 `snapshotEvents()`、`CallId` 在发布线上叫
  `ToolCallId`（`@deepseek-ai/dsh-llm/brand`）、`MessageSourceMap['plugin']` 可由本包自己的
  `'oikonomia-eye'` kind 自解。逐条证据（包名 + 版本 + `.d.ts` 文件:行 + 原文）见
  [RISKS.md](RISKS.md) §2.4，与 monorepo 源码面的差异见[上一节](#与-monorepo-源码面的一致性说明)。
- **【本轮已解决】declaration merging 对消费方可见**：`src/types.ts` 的那两处 `declare module`
  会被 `tsup` 的声明构建裁掉，因此构建脚本把它们复制进 `dsh/index.d.ts`（消费者 `import` 本包时
  必然加载的那个文件）。消费者**只需要 `import` 本包**，不需要任何额外动作。修法、双证与唯一的
  边界（只 `import` 本包的 `/invariant` 子路径时不生效）见[发布形态与类型可见性](#发布形态与类型可见性)。
- **【前移轮更新】2 个用例仍失败，都不是类型问题**：(1) `checkpoints.spec.ts` 的"数别人的提醒"
  —— 本包的 `post-execute` 监听器在瀑布**下游**（`await next()` 之后才数 `downstream.additionalContexts`），
  因此看不到同批次里"后来者"追加的上下文；两种注册顺序实测都是 `duplicateReminders = 0`。
  (2) `composition.spec.ts` —— 组合里的 `@deepseek-ai/dsh-agent-spine-demo` 在 registry 上只到
  `0.1.2-alpha.2`（`latest` 是 `0.0.1-rc.1`），低于本包 peer 区间下界 `0.1.2-rc.1`，该行起不来。
  两条的原因与"需要上游做什么"见 [RISKS.md](RISKS.md) R10。
- **【前移轮更新】`snapshotEvents()` 是弃用 API**：发布线给"读日志快照"的非弃用入口是
  `session.surface`，而它只给序号、不含事件。本包只能用弃用方法；需要上游提供一个非弃用的日志读入口。
- **【前移轮更新】本机跑测试要加 `--pool=threads`。** 本机 vitest 的默认 `forks` 池会**静默退出**
  （只打印一行 `RUN`、exit 1、一个用例都不跑），因此本 README 与 [RISKS.md](RISKS.md) 里的所有测试数字
  都来自 `--pool=threads`。这是本机子进程 spawn 被拦，不是包的问题；`package.json` 的 `test` 脚本未改。
  该池复现出的基线与上一轮一致（32 过 / 45 挂），所以两轮数字可比。
- **【前移轮更新】`foreignReminders` 的判据降级为近似**：发布线取消了共享的 `kind: 'plugin'`，
  改判"kind 不属于 `user/model/tool/system-prompt`"。同批次里 `kind: 'user'` 的消息不再计入。
- **注入是"加"而不是"换"。** 计划书那条"模型可见上下文预算不增"未达成。任何瀑布流监听**都能**删掉别的插件的提示段，而被标为 `complete` 的段又会绕过这次删除，因此 trim 等于悄悄改动一个不属于本插件的契约。本包改用恒定注入预算约束这次追加，并把可见总量记进每一轮。
- **位置、漂移与修正项缺席**，**档位策略未实现**：`axes: 'off'` 与 `gear: 'default'` 是轮次记录唯一可能的值，因此没有轮次能记录档位效果。
- **拒绝只覆盖一种条件类型**（`requires`）。**读不到路径参数的调用落在 guard 范围之外。**
- **计数键是"被覆盖工具 + 其范围"，不是精确参数**：同一个被覆盖工具上的两条不同命令会互相计为重复——这是"同一动作"的预定读法，同时也是它的不精确处。
- **带 `coordinate/round` 的日志需要本包才能恢复。** 该事件 required-on-read：未加载本包的运行时会拒绝该会话，而不是重建一份有洞的日志。这是计划书的裁定，并且刻意响亮。R5/R6 的记录变更之前写下的轮次记录**不再满足本包不变量**：不变量会拒绝更旧的字段，而"缺少行为字段"有它自己的拒绝信息。按预发布立场**不提供兼容 shim**。
- **`duplicateReminders` 只计检查点能观察到的部分**，两次观察之间异步交付的提醒不计入。
- **双提醒默认合并，互斥抑制后置。** 计划书把互斥抑制留待墙纸率实测，因此当前只记录 `duplicateReminders`，不做抑制。
- **token 数是 meter 的计价，不是分词器计数。** 未加载 meter 时轮次记 `tokenSource: 'unavailable'` 并省略该数，而不是另用启发式给文本计价。刻意没有"必须加载计量器"的开关：那是**部署组合**的属性，不是本插件的属性（加载期检查会因配置行顺序而误判，首轮检查又会在轮次中途抛错）。
- **新判据准入缺席。** 作者命令只起草条目；没有任何检查判断这条新判据是否开辟了新区域，也没有按内容哈希去重。
- **eval 入口是本地命令。** `eval/reconcile.mjs` 在本机运行权威闸门；计划书不承诺 CI 入口，本包也不声称有。
- **拒绝的组装级证据止于探针工具。** 组装组合与其快照用探针工具；出厂工具上的拒绝只在包级测试里行使过。
- **`requires` 条件的作用域是整个会话**（作者裁定，2026-10-15）：更早轮次里跑过的工具仍然满足该条件，检查读的是会话日志而不是当前轮。提醒所依据的重复计数仍然是当前轮的事实。
- **路径 glob 的双星是本包的读法，不是规范。** `**/` 匹配零个或多个目录段，因此 `**/*.md` 既覆盖裸文件名也覆盖嵌套路径；单个星号不跨分隔符。
- **轮次记录的耐久性属于宿主，不属于本包。** `coordinate/round` 经会话日志追加，本包自身不写任何文件；每条追加是否逐条 fsync、还是走水位 + checkpoint 批量落盘，是会话持久化提供方的策略。
- **曝光窗口按整个部署的轮次计数，不按单个会话。** 一条判据在一个会话里只进一次块，因此按会话计的窗口会恒为 `1`、不含信息。
- **曝光窗口与行为距离都是内存态，随部署重启归零。** `windowRounds` 只回数本进程见过的轮次：重启后最初若干轮报告的窗口小于 `exposureWindowRounds`，而"重放日志重建窗口"未实现。由于该窗口是墙纸率的分母，**任何此类读数都必须注明它来自冷启动还是热部署**。
- **本包未测：** 真实会话的端到端每轮 pre-step 延迟、双提醒决策所等待的墙纸率、以及任何 V1 效应量。本包提供了这些测量所需的可运行组合与留痕，但不声称测过它们。

## 非预注册项与追认状态

本包中计划书**未预注册**的读数与待定读数。**引用其中任何一项都必须同时带上它的性质；一项都不得当作预注册判据使用。**

| 项 | 出处 | 性质 | 是否参与判定 | 追认状态 |
|---|---|---|---|---|
| 部署级曝光窗口（`exposureWindow`、`windowRounds`） | 本包对墙纸率分母的读法 | 自选读法，计划书未写 | 每轮留痕；无任何闸门判定依赖它 | **【待作者追认】—— 本包不主张任何墙纸率** |
| 条件作用域 = 整个会话 | 作者裁定，2026-10-15 | 已裁定 | 是，两条测试钉住 | 已追认 |
| `dropped` 元素形如 `<entryId>@<source>` | 计划书十三补 1.1 / 协调者裁定 | 耐久字段**形态变更** | 是，不变量校验形态 | 已追认；更早写下的记录不再通过 |
| 条目表内容哈希 `sha256_16` | 计划书十三补 1.5（作者） | 真源必填字段 | 是，加载期校验 | 已追认 |
| 测试夹具里的伪戳必须保持哈希形状 | 本包测试套件 | 陷阱：全数字值会被 YAML 解析成数字，于是拒绝报的是缺戳而不是不匹配 | 篡改用例里点名 | 不适用，记录于此以免下一个夹具再踩 |
| 三条引用读数（0.007–0.024 ms、20.84%、12/12） | 协调检出处的证据表 | 外部引用 | 否 —— 不是本包测量值 | 不适用，已按时点与摘要声明为引用 |
| `behaviorDelta` 的定义 | 本包提案（第 3 块） | 已实现的机械口径 | 是：每轮留痕，且**本包不据此主张任何墙纸率** | **【待作者追认】** |

### 关于 `behaviorDelta` 的限定原文

轮次还报告每条曝光判据所覆盖的动作在其观察窗口内**是否复现**——这是墙纸率所需的**分子**。定义是机械的：判据在一轮里**到达模型**即为"曝光"（被注入，或被 deny/提醒/对账据以行动），窗口 = 其后 `exposureWindowRounds` 个**部署级轮次**。状态只有三种，且彼此**不同形**：`recurred`、`held`、`unobserved`。**不覆盖任何动作的判据不出现在其中**，因为"这里什么也没观察到"与"观察到了、没有复现"不是同一件事。距离按**本轮**写，因此不会回退；判决在窗口关闭时定下，其后到达的调用不会把 `held` 追认成 `recurred`。

这份留痕给出的是**可区分性与可检性，不是正确性**。三种状态文本不同、距离能区分同一状态的两次观察、两个时钟读数让距离**可重算**（`roundsSinceExposure` 必须等于 `behaviorRound - exposedAtRound`，由本包不变量保证）——而不是听信产出者的说法。但状态与距离由同一次计算产出，**两边一起算错**仍会通过：不变量证明的是记录**不自相矛盾**，不是观察正确。**这是一个自选的机械口径，在作者追认之前不应据此主张任何墙纸率。**

## 仓库布局

```
dsh/                构建产物：index.js / invariant.js（+ 声明与 sourcemap），由 exports 暴露；不提交
src/                源码，11 个文件
tests/              10 个 spec + support/mock-adapter.ts（见下「测试支持自带」）+ fixtures/composition-driver.ts
examples/fixtures/oikonomia-eye/   示例部署数据：lexicon.yaml、entries.yaml、corpus/、cordis.yml、fixture 插件
eval/               本地工具：条目表打戳（stamp-entries.mjs）、权威闸门对账（reconcile.mjs）
scripts/            打包自检、peer 区间断言、profile 冒烟、npm 定位
cordis.patch.yml    bundle 层插入行
DEPENDENCIES.md     依赖勘定：逐条 import → peerDependencies 集合
EXTRACTION-PLAN.md  抽取计划：搬什么、改写什么、丢什么、什么顺序
RISKS.md            风险清单
```

## 开发

```sh
pnpm install          # peer 依赖不会自动装：auto-install-peers=false
pnpm run lint         # 通过：eslint src tests，0 error
pnpm run peers:assert # 通过：7 条 dsh peer 共用一条区间链 + 8 个版本断言
pnpm run typecheck    # 通过：0 error（前移前 75）
pnpm run test         # 77 个用例：75 过 / 2 挂（前移前 32 过 / 45 挂）
pnpm run build        # tsup → dsh/index.js、dsh/invariant.js、声明与 sourcemap（含 dts，已通过）
pnpm run check-pack   # 打包后自检：tarball 内容 + 装进消费者后能否被 node import
```

**本机跑测试要加 `--pool=threads`**：本机 vitest 的默认 `forks` 池会静默退出（只打印一行 `RUN`，
exit 1，一个用例都不跑），这是本机子进程 spawn 被拦，不是包的问题。
`pnpm run test` 脚本本身**没有**改（见 [RISKS.md](RISKS.md) R10）。

CI（`.github/workflows/ci.yml`）跑 install → typecheck → lint → test → build → check-pack；
`typecheck` 与 `build` 两步现在应当全绿，`test` 还剩上面那 2 例（在 CI 上还需确认池的选择）。

## 发布形态与类型可见性

**随包发的文件**（`files` 白名单，tarball 实际 20 个）：`dsh/`（`index.js`、`invariant.js` 与两个
`.js.map`、`index.d.ts`、`invariant.d.ts`）、`cordis.patch.yml`、`eval/` 的 3 个文件、
`examples/fixtures/oikonomia-eye/` 的 5 个文件，以及 `package.json`、`README.md`、`LICENSE`、`NOTICE`、
`CHANGELOG.md`。本包**没有** `dist/`，也**没有** CLI 或客户端半边。
`files` 里还列着 `skills` 与 `docs` 两个**并不存在**的目录：npm 会静默跳过它们，因此 tarball 里没有，
这不是打包缺陷；两处是给尚未搬入的内容留的位（见 [RISKS.md](RISKS.md) R10）。

**消费方怎么拿到类型**：`exports["."]` 是 `{ types: ./dsh/index.d.ts, default: ./dsh/index.js }`，
所以 TypeScript 按包名解析本包时读的就是 `dsh/index.d.ts`。

**合并键就在那个文件里。** 本包向两个宿主类型表各加一个键：

| 宿主包 | 类型表 | 本包加入的键 |
|---|---|---|
| `@deepseek-ai/dsh-llm` | `MessageSourceMap` | `'oikonomia-eye'` |
| `@deepseek-ai/dsh-session/types` | `SessionEventMap` | `'coordinate/round'` |

`declare module` 只在**读到了该声明的那个程序**里生效。`tsup` 的声明构建把程序摇到只剩包根可导出的
符号，而 `src/types.ts` 是纯类型模块、导出全被擦除，于是这两处 augment 被整个裁掉。因此
`scripts/inject-augments.mjs` 在构建后把它们从 `src/types.ts` 的 `#augment:emit` 标记区**逐字节复制**
进 `dsh/index.d.ts` —— 那是每个 `import` 本包的消费者必然加载的文件，所以 augment 必然进入消费者程序。
脚本不在自己这里重抄一遍声明，源码是唯一真源；标记缺失即报错退出，不会悄悄少发一个键。

**消费方需要做什么：只 `import` 本包。** 不需要 `import type {} from 'dsh-oikonomia-eye/types'`，
不需要 `/// <reference types="..." />`，不需要 `tsconfig` 里的 `types` 或 `paths`，也不需要自己写一份
同形 augment。装了 `peerDependencies`（两个宿主包）就能读到键：

```ts
import 'dsh-oikonomia-eye'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'

const key: keyof SessionEventMap = 'coordinate/round'   // 编译通过
type Round = SessionEventMap['coordinate/round']        // 就是本包的 CoordinateRound
```

**唯一的边界**：只 `import 'dsh-oikonomia-eye/invariant'`、从不 `import` 包根时，消费者程序不加载
`dsh/index.d.ts`，因此看不到这两个键。`invariant` 子路径是给组合里的伴随插件用的，它自己不带
`OikonomiaEyeSource`/`CoordinateRound` 的声明，把 augment 复制进去会引入未定义名，所以**只注入包根**；
组合里挂本包时加载的正是包根，所以正常部署不受影响。

**怎么确认发出去的东西是对的**：`pnpm run check-pack` 除文件表外，还读出**真 tarball 里**
`dsh/index.d.ts` 的 `declare module` 行并在一个都没有时判 FAIL；`pnpm run augment:check` 是不写文件的
漂移检查（`--check` 模式）。`pnpm run build` 可重复执行，连跑两次产物逐字节相同。

`DSH_OIKONOMIA_EYE_NO_DTS=1` 的 `build:no-dts` 只是类型阻塞期的逃生门：它**不**产出声明，因此
**不是**可发布形态 —— 那样打出的 tarball 里没有 `dsh/index.d.ts`，消费方拿不到任何类型，更拿不到合并键。
`npm publish` 的 `prepack`/`prepare` 会走正常的 `build`，所以从打包路径发布时声明总是带 augment 的。

## 来源修订

本骨架依据 deepseek-harness 工作区 `packages/experimental/oikonomia-eye` 在
**2026-10-15T14:30:14Z** 的读取内容得出；抽取（本轮）期间又读取了三次。**该包在此期间被另一个执行者继续修改，
因此这些摘要都只是时点快照，不是稳定的冻结点。**

| 读取时刻（UTC） | `src/**` 聚合 sha256[:16] | 说明 |
|---|---|---|
| 2026-10-15T14:30:14Z | `8126df37d813b93f` | 骨架与 DEPENDENCIES.md 的依据 |
| 2026-10-15T14:37:59Z | `8126df37d813b93f` | 抽取动手前复算：与骨架依据**逐文件一致** |
| 2026-10-15T14:47:36Z | `80f5fdc5758706ef` | `src/checkpoints.ts` 被上游改（新增 owed 交付路径，439 行） |
| 2026-10-15T14:49:34Z | `719cc9433fa8c878` | 上游在同一文件又改了一次（末行尾随空格） |

本仓库 copy 的是 14:47:36Z 之后的 `checkpoints.ts`（语义等同上表最后一次读取，只差一处尾随空格）；
其余 10 个 `src/*.ts` 到 14:49:46Z 仍与骨架依据逐字节一致，只有 `@module` 标签被改写。
逐文件摘要见 [DEPENDENCIES.md](DEPENDENCIES.md)。

## 仓库归属

`repository` / `homepage` / `bugs` 均为 `https://github.com/Bingtang1019/dsh-oikonomia-eye`
（`bugs` 指向其 `/issues`）。**仓库名已由作者于本轮确认**，不再是占位值；发布后这三个字段指向真实仓库。
见 [RISKS.md](RISKS.md) 的 R9。

## 许可

MIT，见 [LICENSE](LICENSE)；第三方声明见 [NOTICE](NOTICE)。
