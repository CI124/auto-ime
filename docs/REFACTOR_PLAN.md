# Auto IME 架构巡检与重构计划

> ## ⚠ 勘误（2026-09-21，第三轮巡检后补）
>
> 本文档的**问题清单仍然有效**，但下列结论已被推翻，读到这里时请先看修正：
>
> | 本文的声称 | 实际 |
> |---|---|
> | T2「已新增 CI」已勾选 | `ci.yml` 当时被 `.gitignore` 白名单排除在仓库外，**远端从未跑过一次**。现已入库并补了仓库自检门禁 |
> | 批次 1-4 已全部完成 | 当时全部改动**未提交**，无回滚点；现已按主题拆成多个 commit |
> | T1「ast-analyzer-test 已测真实源码」已完成 | 测试靠「每用例新建实例」规避了一个**真实缺陷**（未传 `tree.edit()` 的增量复用导致节点错位），属假绿灯；已修源码并补同实例回归用例（ADR 0003） |
> | P1「快路径避免整篇 `getText()`」 | 只消除了字符串物化，**全文 `lastIndexOf` 回溯扫描仍在**；且块注释快路径存在假阳性，已修（引号成对校验） |
> | 未提及：语言覆盖缺口 | 未登记语言（markdown/plaintext 等）会被当成代码抢切英文；已改为整轮不干预（ADR 0005） |
> | 未提及：粒度/复杂度**无任何门禁** | 现已有 `npm run lint`（真 AST）+ baseline 冻结增长（ADR 0004） |
>
> 本轮新增决策记录见 `docs/adr/0001`…`0006`；未完成项与下轮热点见 `CHANGELOG.md` 的「已知残留」。

---

> 版本基线：v0.9.0（commit `1773e30`）· 巡检日期：2026-09-20
> 范围：`src/` 全部 15 个 TS 模块（约 2096 行）、`test/` 4 套测试、`scripts/`、`esbuild.js`、`package.json`
> 目标：发现依赖腐化、重复代码、死代码、安全漏洞、性能热点、测试缺口，作为下轮重构依据。
> 说明：本文档为**待办计划**，尚未改动任何代码。勾选框用于跟踪执行进度。

---

## 0. 总体判断

- 架构分层**健康**：`logger`(基座) → `core`(接口/编排原语) → `platforms`/`modes`(实现) → `extension`(装配)，**无循环依赖**。
- v0.9.0 清理成效明确：Linux 管理器抽象、IMM32 死代码移除、双轮询合并。
- 实质技术债集中在三点：**测试可信度**（假绿灯 + 无守门）、**少数接线/热路径遗留**（定时器泄漏、快路径全文取串、无防抖）、**低风险清理项**。

---

## 1. 依赖图与分层

```
extension.ts (入口/编排)
 ├─ ASTAnalyzer.ts ── logger.ts
 ├─ core/controller.ts ─(具体类依赖, 见 B1)─> ASTAnalyzer / state-tracker / types / logger
 ├─ core/state-tracker.ts ── types / logger
 ├─ core/poller.ts (无外部依赖)
 ├─ core/types.ts ── logger, vscode
 ├─ modes/normal.ts ── types ; modes/vim.ts ── types / logger
 └─ platforms/index.ts ─(require 运行时)─> windows/adapter | linux/adapter
      windows/adapter ── poller / types / logger / win32/ime-ffi / dual-keyboard / single-keyboard
      dual/single-keyboard ── types / logger / win32/ime-ffi
      linux/adapter ── poller / types / logger, child_process/fs/os/path/vscode
      win32/ime-ffi ── koffi / logger
```

**结论**：无循环；`platforms/index.ts` 的动态 `require()` 为合理设计（避免 koffi/双平台进同一 bundle）。

---

## 2. 完整修复任务表

### A. 分层与模块边界

| 编号 | 问题 | 位置 | 修复动作 | 影响 | 风险 | 工作量 | 批次 |
|---|---|---|---|---|---|---|---|
| B1 | `core/controller` 硬依赖具体类 `ASTAnalyzer`，核心层不纯 | `src/core/controller.ts` | 抽 `IAnalyzer`（`isCursorInCommentFast`/`isCursorInCommentOrString`/`init`/`dispose`），构造注入 | 可测性/解耦 | 低 | S | 批3 |
| B2 | `core/types.ts` 直接 `import vscode` | `src/core/types.ts` | 保留现状（扩展固有），仅文档标注；B1 后连带降低影响 | 中 | 高 | — | 仅记录 |
| B3 | `ASTAnalyzer.ts`/`logger.ts` 与入口同级、层级混排 | `src/` 根 | 移至 `src/analysis/`、`src/infra/`（含 import 路径更新） | 可读性 | 低 | S | 批4 |
| B4 | `platforms/index.ts` 用 `require()` 动态加载 | `src/platforms/index.ts` | **判定合理、不改**，加注释说明 | 无 | — | — | 不改 |

### B. 重复代码

| 编号 | 问题 | 位置 | 修复动作 | 影响 | 风险 | 工作量 | 批次 |
|---|---|---|---|---|---|---|---|
| D1 | dual `switchToEnglish/Chinese` ~85% 重复 | `src/platforms/windows/dual-keyboard.ts:37-71` | 仿 single `apply()`，抽 `private apply(langId, targetKey)` | 中 | 低 | S | 批2 |
| D3 | vim "Insert→Normal forceEnglish" 分支写两遍 | `src/modes/vim.ts:60-64` ↔ `:92-98` | 合并 `handleCursorStyleTransition(from,to,ctx)` | 中(易错分支) | 低 | S | 批2 |
| D4 | linux 三处重复 exec 选项对象 | `src/platforms/linux/adapter.ts:50-85` | 提 `buildExecOpts(timeout)` 助手 | 低 | 低 | S | 批4 |
| D5 | ts/tsr/js/jsr profile 数据重复 4 遍 | `src/ASTAnalyzer.ts:37-60` | 共享模板工厂生成条目 | 低 | 低 | S | 批4 |
| D2 | normal/vim selection+document 订阅骨架重复 | `src/modes/normal.ts:17-29` ↔ `src/modes/vim.ts:54-81` | 差异仅 insert 守卫，收益有限；处理 DD1 时一并评估 | 低 | 中 | S | 仅记录 |

### C. 死代码 / 泄漏

| 编号 | 问题 | 位置 | 修复动作 | 影响 | 风险 | 工作量 | 批次 |
|---|---|---|---|---|---|---|---|
| **DD1** | Vim `modeDetectionTimer`(20ms) 未进 disposables，`listener.dispose()` 从未调用 → 切换/deactivate 泄漏 | `src/modes/vim.ts:105-118`、`src/extension.ts:252` | ①`register()` 返回内含清 timer 的 `Disposable`；或②`registerModeListener` 替换/注销时显式调用旧 `listener.dispose()` | **高(正确性)** | 低 | S | **批1** |
| DD2 | `SwitchResult.success` 全库无读取点 | `src/core/types.ts:61` | 建议让 controller 在 `!success` 时告警（消费它）；否则删字段 | 中 | 低 | S | 批3 |
| DD3 | `createNullLogger()` 无引用 | `src/logger.ts:58` | 删除 | 低 | 低 | XS | 批4 |
| DD4 | ime-ffi 仅内部用的 `export`（GetForegroundWindow/PostMessageW/…） | `src/win32/ime-ffi.ts:31-61` | 收为模块私有，仅保留跨文件使用者 | 低 | 低 | S | 批4 |

### D. 依赖与安全

| 编号 | 问题 | 位置 | 修复动作 | 影响 | 风险 | 工作量 | 批次 |
|---|---|---|---|---|---|---|---|
| V2 | `download-wasm.js` 无完整性校验、重定向未复核主机；wasm 已入库、重复下载 | `scripts/download-wasm.js` | 加 sha256 清单校验；强制同站(https/unpkg)重定向；已存在即整体跳过 | 中(供应链) | 低 | S | 批2 |
| V3 | 冗余直接依赖 `@koromix/koffi-win32-x64`（本属 koffi optional） | `package.json:105` | 移除，交由 koffi 自带平台包 | 低 | 中(需验证打包) | S | 批3 |
| V3b | `@types/node:18`(EOL)、`target:node16`、`engines.vscode:^1.80` 偏旧 | `package.json` | Node types→20/22、评估提升最低 vscode 版本 | 低 | 中 | S | 批4 |
| V1 | `esbuild<=0.24.2` moderate 告警（仅 dev-server，项目不用 serve） | `esbuild.js` | **不 `--force`**；升级至 0.25.x 或记录豁免 | 低(攻击面≈0) | 低 | XS | 批4 |

### E. 性能热点

| 编号 | 问题 | 位置 | 修复动作 | 影响 | 风险 | 工作量 | 批次 |
|---|---|---|---|---|---|---|---|
| P1 | 快路径含块注释语言每次 `document.getText()` 取整篇 | `src/ASTAnalyzer.ts:259-269` | 缓存文档文本/按 (uri+version) 失效；块注释改增量行扫描 | 中(热路径 O(n)) | 中 | M | 批3 |
| P3 | `analyzeAndSwitch` 由事件直触、无防抖（注释声称的动态防抖未实现） | `src/core/controller.ts:72` | 加行级 debounce（按文件大小 10/30/60ms），与 generation 取消协同 | 中 | 中 | M | 批3 |
| P2 | Vim Normal 态 20ms 轮询 cursorStyle | `src/modes/vim.ts:118` | 前置 DD1；评估延长间隔或改用 `onDidChangeTextEditorOptions` 事件 | 中 | 中 | S | 批3 |
| P4 | 轮询频率本身（Linux 100/500ms+exec；Win 150ms） | `src/platforms/linux/adapter.ts` | **判定已合理，仅记录** | 低 | — | — | 不改 |

### F. 测试缺口

| 编号 | 问题 | 位置 | 修复动作 | 影响 | 风险 | 工作量 | 批次 |
|---|---|---|---|---|---|---|---|
| **T2** | 无 `npm test` 聚合入口、无 CI | `package.json` scripts | 加 `scripts.test` 串起四套测试；新增 CI（win+linux matrix 跑 compile+test） | **高(回归防线)** | 低 | M | **批1** |
| **T1** | `ast-analyzer-test.js` 内联复现逻辑、不加载真实 `ASTAnalyzer`，副本已漂移（CSS `//`、块注释、`@string`/`@comment`） | `test/ast-analyzer-test.js:93-205` | 重写为加载真实编译产物里的 `ASTAnalyzer`；删内联副本，用真源码跑同批用例 | **高(假绿灯)** | 中 | M | **批1** |
| T3 | 关键行为仅靠 bundle 文本 `includes`/`indexOf` 断言，锁死命名妨碍重构 | `test/mock-*.js` | 逐步以行为断言替换文本断言；重构期先同步更新断言 | 中 | 中 | M | 批3 |
| T4 | 真实 `execFileSync('bash')` 分支在 Windows 不执行 | `src/platforms/linux/adapter.ts` | 由 T2 的 CI Linux matrix 覆盖真实命令 | 低 | 低 | S | 批2(随CI) |
| T5 | controller 状态机（manualOverride、fast/AST skip）、vim 光标状态机无单测 | `src/core/controller.ts`、`src/modes/vim.ts` | 借 B1 抽接口后补 mock 驱动行为测试 | 中 | 中 | M | 批3 |

---

## 3. 执行顺序与进度勾选

### 批1 · 正确性与守门（先做）
- [x] **DD1** Vim `modeDetectionTimer` 泄漏修复（唯一确认的真实缺陷）
- [x] **T2** 新增 `npm test` 聚合脚本 + CI（win+linux matrix）
- [x] **T1** 让 `ast-analyzer-test.js` 测真实 `ASTAnalyzer`，删除漂移副本

> 理由：先堵泄漏，再建立"改任何代码都有真红绿灯"，后续重构才安全。

### 批2 · 低风险高确定性清理
- [x] **D1** dual-keyboard 抽 `apply()`
- [x] **D3** vim 光标状态转换合并 `handleCursorStyleTransition()`
- [x] **V2** `download-wasm.js` 加校验 + 跳过策略
- [x] **T4** CI 顺带覆盖 Linux 真实命令

### 批3 · 结构与性能
- [x] **B1** 抽 `IAnalyzer` 接口注入（解锁 T5/T3）
- [x] **T5** controller / vim 状态机行为测试
- [x] **T3** 文本断言 → 行为断言迁移（部分：新增 controller 行为测试 + 真实 ASTAnalyzer 测试；`mock-*.js` 的 bundle 文本断言暂保留，后续可继续迁移）
- [x] **DD2** `SwitchResult.success` 消费或删除
- [x] **V3** 移除冗余 `@koromix/koffi-win32-x64`
- [x] **P1** 快路径避免整篇 `getText()`
- [x] **P3** `analyzeAndSwitch` 行级防抖
- [x] **P2** Vim 轮询间隔/事件化评估

### 批4 · 整理与对齐
- [x] **B3** 目录整理（`analysis/`、`infra/`）
- [x] **D4** linux `buildExecOpts()`
- [x] **D5** LANGUAGE_PROFILES 模板去重
- [x] **DD3** 删 `createNullLogger()`
- [x] **DD4** ime-ffi 冗余 `export` 收私有
- [x] **V1** esbuild 版本处置（不 `--force`）
- [x] **V3b** 依赖版本对齐

### 不改 / 仅记录
- B2（types 依赖 vscode）、B4（动态 require）、D2（订阅骨架）、P4（轮询频率）

---

## 4. 全程约束（务必遵守）

1. **Bundle 文本强耦合**：`test/mock-koffi-test.js`、`mock-linux-ime-test.js`、`mock-tsf-test.js` 直接读 `dist/extension.js` 文本做断言，锁定 `queryIMEMode`、`sendImeToggle`、`setIMEMode`、`VK_SHIFT`、`VK_CONTROL`、`keybd_event`、`startAdaptivePolling`、`runBashAsync`、`queryModeAsync`、`notifyAutoSwitch`、`handleExternalSwitch`、`manualOverride` 等命名与函数顺序。
   - **任何重命名 / 抽函数 / 删死代码，先核对并同步这些断言。**
   - 改动前后各跑一次四套 mock 测试对照基线。
2. **`ast-analyzer-test.js` 当前不加载真实源码**（自身 `import web-tree-sitter` 复现逻辑），改 `ASTAnalyzer.ts` 时它不会给出真实反馈——T1 完成前不要依赖它验证核心逻辑。
3. **构建命令**：`npm run compile`（一次性）/ `npm run watch`（监听）；`precompile`/`prewatch` 会先跑 `scripts/check-env.js`；`npm install` 触发 `postinstall` 下载 wasm（见 V2）。
4. 每批次结束跑：`tsc` 0 error、`npm run compile` 成功、四套测试全绿，再进入下一批。

---

## 5. 验收标准（Definition of Done）

- 批1 后：`npm test` 一条命令跑通全部测试；CI 在 win+linux 通过；`ASTAnalyzer` 用例基于真实源码；无残留 20ms 定时器泄漏（Vim 切 Normal/deactivate 后可观测到 interval 被清）。
- 全部批次后：上述任务表所有非"不改"项勾选完毕；重复块消除且行为不变；供应链与版本项闭环；性能项有前后对比数据。

---

## 6. 执行记录（本轮完成）

基线：批前 4 套测试全绿（koffi 30、tsf 17、linux 56、ast 22）。收尾时 `tsc --noEmit` 0 error、`npm run compile` 成功、`npm test` 5 套全绿、`npm audit` **0 漏洞**。

### 关键取舍 / 与原计划的偏差
- **DD2（`SwitchResult.success`）**：巡检只看了 `src/` 判断“无读取点”，但复核发现 `mock-tsf-test.js`/`mock-linux-ime-test.js` **会断言 `success` 字段**（失败切换应 `success:false`）。故不删字段，改为让 `controller.switchTo` 在 `!success` 时记 `FAILED` 告警以真正“消费”它。
- **V1（esbuild）**：实际升级到 `^0.25`（非 breaking），`npm audit` 归零，未采取“豁免”。
- **V3b**：`@types/node` 升到 `^22`；**保留** `engines.vscode ^1.80` 与 `target: node16`（抬高最低版本属用户面决策，暂不动）。
- **V2（download-wasm）**：新增内置 SHA-256 清单 + 同源 https 重定向限制 + 下载后校验（不匹配即删除报错）、已存在文件校验（仅告警）。
- **T3**：以“新增行为测试”方式**部分**收敛——新增 `test/controller-test.js`（11 项，驱动真实 `IMEController` 状态机）+ 重写 `ast-analyzer-test.js` 加载真实源码（22 项）。`mock-*.js` 的 bundle 文本断言按原样保留（仍全绿），后续可继续迁移。

### 新增 / 变更文件
- 新增：`src/core/poller` 无变；`src/infra/logger.ts`、`src/analysis/ASTAnalyzer.ts`（由根目录 `git mv` 迁入，B3）；`.github/workflows/ci.yml`（T2）；`test/controller-test.js`（T5）。
- 重写：`test/ast-analyzer-test.js`（T1，测真实源码）、`scripts/download-wasm.js`（V2）。
- 行为增强：`controller.ts`（IAnalyzer 注入 + 行级防抖 + dispose + 消费 success）、`vim.ts`（定时器泄漏修复 + 转换去重 + 轮询 20→40ms）、`dual-keyboard.ts`（`apply()` 去重）、`linux/adapter.ts`（`execOptions()`）、`ime-ffi.ts`（内部绑定收私有）、`logger.ts`（删 `createNullLogger`）、`types.ts`（新增 `IAnalyzer`）。

### 守门回顾
全程遵守“bundle 文本强耦合”约束：仅新增/内联重构，未删除被断言锁定的标识符（`sendImeToggle`/`VK_SHIFT`/`keybd_event`/`startAdaptivePolling`/`runBashAsync`/`queryModeAsync`/`handleExternalSwitch`/`manualOverride`/`notifyAutoSwitch` 等），函数顺序不变；每批改动后 `npm test` 对照基线。

### 遗留（本轮有意不做，非缺陷）
- B2、B4、D2、P4：判定合理/收益不足，仅记录。
- T3 完全迁移、engines.vscode 抬高：留待后续按需在真实 VS Code 环境验证。
