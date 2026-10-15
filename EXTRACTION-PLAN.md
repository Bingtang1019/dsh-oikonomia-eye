# 抽取计划 — 从 monorepo 到独立仓库

**本文件是本 kit 的施工图。** 它逐条给出：必须搬什么、必须改什么、必须丢什么、以及什么顺序。
本轮**只交骨架**：`src/`、`tests/`、`eval/`、`dsh/` 都还没搬（见 README 顶部状态说明）。

## 0. 前置：重新勘定源修订

本计划与 [DEPENDENCIES.md](DEPENDENCIES.md) 依据的读取时刻是 **2026-10-15T14:30:14Z**，`src/**` 聚合摘要
`8126df37d813b93f`，拷贝集聚合摘要 `445d96d25b6ef2a4`。当时另一个执行者正在改该包
（`git status --porcelain` 共 15 行：12 个 `M` 与 3 个 `??`，含未跟踪的 `src/exposure.ts`）。

**施工第一步不是复制，是重算摘要。** 源若已变，本文与 DEPENDENCIES.md 的行号、逐文件摘要、
以及"哪些测试会断"的结论都要重算一遍再动手。

---

## 1. 必须搬（带证据的清单）

### 1.1 源码 `src/**` —— 11 个文件，全部要搬

| 文件 | 角色 |
|---|---|
| `src/index.ts` | 插件入口：`name`、`Config` schema、四个监听器与作者命令的注册 |
| `src/types.ts` | 全部类型 + **两处 declaration merging**（`dsh-llm` 与 `dsh-session/types`） |
| `src/library.ts` | 读词表/条目表/语料，校验 `sha256_16`，`fileVersion` |
| `src/gate.ts` | `shape-gate/1`：宽词判定、形状触发、条目选择、抑制理由 |
| `src/guards.ts` | guard 编译与范围匹配 |
| `src/checkpoints.ts` | 三个中轮检查点 |
| `src/ledger.ts` | `coordinate/round` 的记录与文本摘要 |
| `src/exposure.ts` | 曝光窗口（**未跟踪的新文件**，最容易漏搬） |
| `src/recall.ts` | 召回文本的截取 |
| `src/command.ts` | 作者录入命令 |
| `src/invariant.ts` | package-owned 不变量 + 独立的 `./invariant` 入口 |

**聚合摘要：`8126df37d813b93f`（11 个 `.ts`，按路径+内容）。**

### 1.2 测试 `tests/**` —— 9 个文件，但**不能原样重放**（见 §2.3 与 RISKS.md R5）

| 文件 | 可原样搬？ |
|---|---|
| `tests/gate.spec.ts` | ✅ 只 import `../src/types.ts` 与 vitest，自足 |
| `tests/stamp-entries.spec.ts` | ✅ 自足（用 `import.meta.dirname` 找 `../eval/stamp-entries.mjs`） |
| `tests/composition.spec.ts` | ❌ 硬依赖 monorepo 的 `examples/headless-agent/tests/fixtures/...` |
| `tests/assemble-trim.spec.ts` | ❌ 依赖 `../../../core/agent-loop/tests/mock-adapter.ts` |
| `tests/behavior-delta.spec.ts` | ❌ 同上 |
| `tests/checkpoints.spec.ts` | ❌ 同上 |
| `tests/ledger.spec.ts` | ❌ 同上 |
| `tests/real-tools.spec.ts` | ❌ 同上（并额外依赖 `dsh-fs-local`、`dsh-tool-fs`、`dsh-fs-observation-policy`） |
| `tests/resident.spec.ts` | ❌ 同上 |
| `tests/shape-injection.spec.ts` | ❌ 同上 |
| `tests/fixtures/composition-driver.ts` | ❌ 依赖 `@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-loader-smoke`（已发布，可装，但 composition 的 `cordis.yml` 与 fixture 目录要一起搬） |

### 1.3 工具与数据

| 项 | 处置 |
|---|---|
| `eval/stamp-entries.mjs` | ✅ 搬。**零外部依赖**（只用 `node:crypto`、`node:fs`），路径全部来自 `argv`，因此独立包里无需改动 |
| `eval/reconcile.mjs` | ⚠️ 搬但**必须改**：默认闸门路径是 `C:/Users/dell/tools/coord/eval/audit_reconcile.py`（见 §2.5） |
| `eval/reconcile-snapshot.json` | ⚠️ 搬；它是本机那次对账运行的快照，独立仓库里没有可重放它的闸门 |
| `eval/README.md` / `eval/README.zh.md` | 搬（双语件，见 §2.6） |
| `README.md` / `README.zh.md` | 搬，但要按本 kit 的 README 重写：包名、安装段、路径、链接（见 §2.4、§2.6） |
| `README.i18n.yaml` / `eval/README.i18n.yaml` | **丢**（见 §3） |
| **示例部署数据** | **必须现场构造**：源包里**没有** `entries.yaml`/`shapes.yaml`/语料。真正被测试读到的三件是 `examples/headless-agent/tests/fixtures/checkpoints/oikonomia-eye/{lexicon.yaml,entries.yaml,corpus/}`（+ `oikonomia-eye-fixture.ts`、`cordis.yml`）。要把它们作为 `fixtures/` 搬进独立仓库，composition 测试才可能重放；其余 spec 在 tmp 目录里自造 YAML，不需要数据文件 |

## 2. 必须改写

### 2.1 workspace 依赖 → peerDependencies

源 `package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` **全部**是 `workspace:^`。
独立包要换成 [DEPENDENCIES.md §2](DEPENDENCIES.md) 得出的确切集合与区间：

- 运行时 peer：`@deepseek-ai/cordis` `^4.0.2`、`@deepseek-ai/schemastery` `^3.18.1`（**从 `dependencies` 移到 peer**，值导入必须与宿主同实例）、`dsh-llm`、`dsh-session`、`dsh-tools`、`dsh-agent`、`dsh-commands`、`dsh-invariants`、`dsh-token-meter`（统一用 rc 区间 OR 链，见 DEPENDENCIES.md §3）；
- 保留普通依赖 `yaml` `^2.9.0`；
- 测试专用进 `devDependencies`（清单见 DEPENDENCIES.md §2.3）。

### 2.2 `tsconfig` 的 project references → 独立配置

源 `tsconfig.json` 是：
`extends ../../../tsconfig.base.json` + `references` **11 项**（`vendor/cordis`、`vendor/schemastery`、`core/agent`、
`core/session`、`core/tools`、`interaction/commands`、`llm/llm`、`llm/token-meter`、`boot/app-boot`、
`runtime-diagnostics/invariants`、`test-support/loader-smoke`）。

独立包**全部删掉**，改成本 kit 已写好的 `tsconfig.json`（noEmit + strict，`include: ["src", "tests"]`）。

**注意两处会咬人的差异：**

1. 仓库根的 `tsconfig.base.json` 用 **`paths` 把 `@deepseek-ai/*` 映射到仓库内 `src`**（源平面）。独立包里没有这个映射，`tsc` 只能走 `node_modules` 里的**已发布** `.d.ts`。因此本地必须真的装齐 devDependencies，类型检查才有依据。
2. 仓库根的 base 设 `verbatimModuleSyntax: false` + `rewriteRelativeImportExtensions: true`；本 kit 的 tsconfig 设 `verbatimModuleSyntax: true`。**源码里所有相对导入都带 `.ts` 后缀**（`./ledger.ts` 等）——`allowImportingTsExtensions` + `noEmit` 下 `tsc` 没问题，但任何"直出 JS"的构建都必须处理这个后缀（`tsup`/esbuild 能，但要实测）。
3. base 还设了 `exactOptionalPropertyTypes: true`。本 kit 的 tsconfig **没有**这一条（照既有插件仓库样式）。若要完全对齐源语义，应把它加回来；否则某些可选字段的赋值会在源里合法、在这里报错。**这是要实测的一项，不是可以假设的一项。**

### 2.3 内部包名引用 → 新包名

全仓替换，逐处核对：

| 位置 | 原 | 新 |
|---|---|---|
| `src/invariant.ts:11` | `const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-oikonomia-eye'` | `'dsh-oikonomia-eye'`（**不变量按包名断言，改错会让不变量报错指向不存在的包**） |
| 各 `src/*.ts` 的 JSDoc `@module` 标签（11 处） | `@deepseek-ai/dsh-experimental-oikonomia-eye/...` | `dsh-oikonomia-eye/...` |
| 各 `tests/*.spec.ts` 的 `import * as Eye from '@deepseek-ai/dsh-experimental-oikonomia-eye'`（9 个 spec） | 同 | `'dsh-oikonomia-eye'`；`ledger.spec.ts` 另有 10 处 `packageName:` 字面量 |
| `cordis.patch.yml` / bundle 行 | — | 本 kit 已写 |

### 2.4 `main`/`types`/`exports`/`files`

源用 `lib/index.js` + `lib/types/*.d.ts`（tsc `outDir`）。独立包按模板形态：`dsh/index.js` 由 `exports["."]` 暴露，
`types` 字段**去掉或指向 bundle 旁的 `.d.ts`**（本 kit 的 `dsh/` 目前不产 `.d.ts`；抽取时要决定"只发 JS"还是"同时发 `.d.ts`"，
后者需要 tsup `dts: true` 且得处理 declaration merging 的可见性——**这是 §4 步骤 3 的实测项之一**）。

`files` 白名单：本 kit 已按模板形状写好（含 `eval`）。**`eval/` 是否该进 npm 包要作者定**：
它是本地工具，装到用户机器上无副作用；若不想发，从白名单删掉并同步 `check-pack` 的必查项。

### 2.5 生成器与闸门的路径依赖

`eval/reconcile.mjs` 里三处**机器相关**默认值：

| 位置 | 现值 | 独立包要改成 |
|---|---|---|
| `DEFAULT_GATE` | `C:/Users/dell/tools/coord/eval/audit_reconcile.py` | 参数或 `OIKONOMIA_EYE_GATE`（脚本已支持两者）；默认值要么删掉"大声失败"，要么改指仓库内 |
| venv 探测 | 闸门同层的 `venv/Scripts/python.exe`（`coord/venv`） | 独立仓库里没有这个 venv；要么让 CI 建，要么把该能力划到"仅作者本机" |
| Python 候选 | `python3`、`python` | 不变，但 CI 要显式提供 |

`eval/stamp-entries.mjs` **无路径默认值**（全部来自 argv），搬运时零改动。

### 2.6 双语件（i18n）

`README.i18n.yaml` / `eval/README.i18n.yaml` 记录的是**两侧 git blob hash**，服务对象是 monorepo 的
`pnpm run verify-translation-pairing` 闸门。独立仓库没有该闸门（本 kit 的 CI 也没有），因此：

- **丢 `*.i18n.yaml`**；
- 双语两侧（`README.md` / `README.zh.md`）**照搬**，但要注意本 kit 的 `README.md` 目前是**中文单篇**。
  抽取时二选一：把 `README.md`（英文）也搬进来形成双语对，或把本 kit 的中文 README 定为唯一权威并删掉英文侧。
  **不要**留下"两份 README 且只有一份是最新"的状态。

## 3. 必须丢（monorepo 专有）

| 项 | 为什么丢 |
|---|---|
| `catalog/`、`docs/persistence-catalog` 类引用 | 仓库生成的目录与闸门产物，独立仓库没有生成器 |
| `.agents/notes/**`（含 `2026-10-15-oikonomia-eye-shape-mode-injection.zh.md`） | 仓库 Agent Note 制度；独立仓库用 `docs/decisions.md` 之类替代。README 里指向它的链接要改成本地文件或删掉 |
| `packages/AGENTS.md` 及其约定的包级不变量规则 | 仓库治理文件，不随包发布 |
| `packages/experimental/` 的 `private: true` 与实验品定位 | 独立包要**可发布**，`private` 必须去掉 |
| 仓库级闸门脚本（`pnpm run hygiene`、`doc-sync`、`verify-md-wrap`、`verify-doc-budgets`、`verify-export-jsdoc`） | 独立仓库只保留本 kit CI 的五步 |
| `tsconfig` 的 11 条 project references 与根 base 的 `paths` | 见 §2.2 |
| `README.i18n.yaml`（两份） | 见 §2.6 |
| `lib/`（含 `lib/tsconfig.tsbuildinfo`） | 构建产物，独立仓库用 `dsh/` + tsup 重建；**不搬** |

## 4. 顺序（五步，逐步可验证）

> 顺序的理由：元数据与 peer 依赖决定"装什么"，装什么决定"能不能编译"，编译产物决定"打包自检查得到什么"。颠倒任一步都要回头重做。

**步骤 1 —— meta。**
写 `package.json`（无作用域名 `dsh-oikonomia-eye`、`exports`/`files`/`scripts`/`engines`）、`cordis.patch.yml`、
`.npmrc`、`LICENSE`、`NOTICE`、`CHANGELOG.md`、`README.md`、`tsconfig.json`、`eslint.config.js`、
`tsup.config.ts`、`.gitignore`、`.gitattributes`、`scripts/`、`.github/workflows/ci.yml`。
**验证：** `node --check` 全部脚本；`package.json` 解析通过；`pnpm install` 能装齐（peer 不会自动装，`devDependencies` 必须显式列全）。

**步骤 2 —— peerDeps。**
按 [DEPENDENCIES.md](DEPENDENCIES.md) §2/§3 落地 `peerDependencies` / `devDependencies` / `dependencies`。
**验证：** 用 `semver` 逐版本断言区间（本 kit 的 `dsh-compat` CI leg 就在做这件事）；
并**验证下界**：在 `0.1.2-rc.1` 上装一次，确认本包用到的每个导出都存在。
（本轮没有做下界验证 —— 见 RISKS.md R2。）

**步骤 3 —— 把 `src/**` 编译成 `dsh/index.js`。**
搬 `src/**`（含未跟踪的 `src/exposure.ts`）+ 改包名/`@module` + 改 `tsconfig`。
`tsup` 把 `src/index.ts` → `dsh/index.js`、`src/invariant.ts` → `dsh/invariant.js`，`@deepseek-ai/*` 与 `yaml` 保持 external。
**验证：** `pnpm run typecheck`（**这是最容易失败的一步**：源平面 `paths` 消失后只能用已发布 `.d.ts`）；
`node -e "import('./dsh/index.js')"` 能导入并导出 `name`；`dsh/` 里**没有**内联的 `@deepseek-ai/cordis`（否则一个进程两个注册表）。
**决策项：** 是否同时产出 `dsh/index.d.ts`（影响 `types` 字段与 declaration merging 对消费方的可见性）。

**步骤 4 —— 搬测试、工具与夹具。**
搬 `tests/**`、`eval/**`、`fixtures/**`（三件示例部署数据）；按 §2.3 改自引用包名；
处理跨包相对导入（自建 mock adapter 或改成已发布包 —— 见 RISKS.md R5）；`composition.spec.ts` 的
fixture 目录与 `cordis.yml` 要一起重定位。
**验证：** `pnpm run test`；`pnpm run lint`。

**步骤 5 —— `check-pack`。**
`pnpm run build` → `npm pack` → `node scripts/check-pack.mjs`。
**验证：** tarball 里含 `dsh/`、`cordis.patch.yml`、`dist/`；`exports["."]` 指向的文件确实在包里；
把 tarball 装进 scratch 消费者后 `node` 能 import 到插件导出。
**这一步必须在 CI 里对两条 DSH 线各跑一次**（`dsh-compat` job），否则"peer 区间写错"只会在用户机器上暴露。

## 5. 与既有插件仓库的形态差异（本 kit 已采用的取舍）

| 项 | 既有模板 | 本 kit | 理由 |
|---|---|---|---|
| client 半边 | `dsh/client.js` + `dsh.client` 声明 | `exports["./client"]` 保留但**不提供文件** | 本包没有 UI；保留入口只是占位，抽取时若确定无 client，应把该 export 删掉 |
| `bin` | `dsh-ppt` → `dist/cli.js` | 无 `bin` | 本包没有 CLI |
| `dsh.client` 声明 | 有 | 无 | 同上 |
| 兼容矩阵脚本 | `scripts/dsh-compat.mjs` + `compat-profile.mjs` | 内联进 ci.yml（`dsh-profile-smoke.mjs` + 一段 semver 断言） | 少两个要维护的脚本；语义等价 |
| LICENSE | **模板仓库里没有 LICENSE 文件**（但 `files` 列了它） | 已写入 MIT | 发布缺 LICENSE 是确定性缺陷 |
