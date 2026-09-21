# 更新日志

本项目所有重要变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 第三轮：建立工程门禁 + 5 项正确性/体验修复（基线 commit `1773e30` 之后）

#### 新增

- **粒度/复杂度门禁** `scripts/check-granularity.js`（`npm run lint`）：基于 `ts.createSourceFile`
  真 AST 统计文件行数/函数行数/分支数/嵌套深度/参数个数；`src/` 五维全硬（400/60、60/100、
  12/15、4/5、5/6），`test/`、`scripts/` 只硬校文件行数与参数。零新增依赖（复用已有 typescript）
- **仓库自检门禁** `scripts/verify-repo.js`：断言 CI 定义、`src/**`、`scripts.test` 引用的测试文件、
  `docs/adr/` 均已入库 —— `.gitignore` 是白名单模式，漏放行会静默让 fresh clone 编译不过
- **wasm 完整性门禁** `scripts/verify-wasm.js` + 清单单一来源 `scripts/wasm-manifest.js`：校验
  SHA-256，并双向核对 `LANGUAGE_PROFILES` 与清单（漏登记 / 死配置都失败）
- **`ValuePoller.pause()` / `resume()`** 与 `IPlatformAdapter.setObserving?`：窗口失焦时暂停外部
  切换轮询（Linux 探针每 100ms 是一个 bash 子进程），恢复焦点后补报一次真实切换
- **`IAnalyzer.supports(languageId)`**：区分“确认不是注释”与“我不知道”
- **`auto-ime.activated` 键位闸门**：两条键位的 `when` 均受其约束，激活失败时 ESC /
  `Ctrl+Shift+Space` 回落给宿主而不是被吞掉
- **测试新增/重写 4 套（共 162 用例）**：`poller-test.js`(7)、`controller-test.js`(16)、
  `vim-mode-test.js`(7)、重写 `ast-analyzer-test.js`(27)，均用 esbuild 内存打包加载**真实源码**
- `npm test` 聚合七套；`.github/workflows/ci.yml` 增加 self-check、verify-wasm、lint 步骤
- **`docs/adr/` 架构决策记录 6 条**（0001 仓库自检、0002 wasm 不入库、0003 全量解析、
  0004 粒度门禁与阈值、0005 未登记语言不干预、0006 失焦暂停轮询）+ `docs/baseline-granularity.json`

#### 修复

- **AST 判定错位（高危）**：取消未传 `tree.edit()` 的“增量解析”。实测：游标上方插入 3 行后
  注释节点退化为 `"functio"@0:0`（真值 `"// head"@3:0`）；而 `lastTree` 是实例级单槽，
  跨文件/跨语言必然复用，且跨语法复用不抛异常，原本“失败降级全量”的 catch 分支永不触发。
  同时把 `tree.delete()` 移到扫描之后（`query.matches()` 的节点仍持有树内存）
- **块注释快路径假阳性**：`const re = "/*";` 之后的代码行会被直接判为注释并跳过 AST；
  现在标记所在行引号不成对时不下结论
- **热路径未处理 rejection**：`analyzeAndSwitch` 全程 try/catch，`doAnalyze` 的 rejection
  转成一条 ERROR 日志与“本轮不切换”（修复前实测两条异常直接逸出到进程）
- **写中文被抢切**：markdown / plaintext / jsonc 等未登记语言不再被当成“代码”强制切回英文，
  而是整轮不干预
- **Vim `modeDetectionTimer` 泄漏**：`register()` 返回的 disposables 内登记清定时器
- **`.gitignore` 白名单漏放行**：`.github/`、`docs/`、`src/core/poller.ts`、两个测试文件
  此前均未入库，因此上一轮声称“已建立 CI”事实上从未在远端跑过一次

#### 变更

- `scripts/check-env.js` 退出 `precompile`/`prewatch` 链路（它在 Linux 无 IME daemon 时
  `exit 1`，会把无头 CI runner 的构建直接刷红）；修正其 D-Bus / `NullManager` 过期文案
- Linux 适配器按职责拆分：`platforms/linux/shell.ts`（bash 执行原语）与
  `platforms/linux/fcitx5-profile.ts`（profile 解析），`adapter.ts` 448 → 357 行
- `npm test` 七套；`npm run lint` / `verify-repo` / `verify-wasm` 新入口
- 文档全面对齐代码现状：`CONTRIBUTING.md`（结构树、模块职责、错误处理不变式、门禁与 ADR
  流程、新语言四步流程、单键盘已接入、imm32/NullManager/不存在的 TODO 等漂移全部修正）、
  `README.md` / `README_EN.md`（“增量解析 3x 提速”等已不成立的宣传、测试用例数、工作原理步骤）

#### 验证

- `npx tsc --noEmit` 0 错误；`npm run lint` OK（32 文件 / 749 函数）；`npm audit` 0 漏洞
- `npm test` 七套全绿 162/162（ast 27、controller 16、poller 7、vim 7、koffi 31、tsf 18、linux 56）
- `git clone` 自检：fresh clone 已可拿到 CI 定义、全部源码与七个测试脚本
- 门禁有效性实测：放入 7 参数 + 6 层嵌套的文件能阻断；启发式识别数低于下限时自行失败

#### 已知残留（本轮有意不做，已记录）

- `mock-*.js` 仍以 `dist/extension.js` 文本与函数顺序为断言对象（锁死命名，妨碍重构），
  迁移到行为断言留待下轮；`src/` 三处软档提示（`isCursorInCommentFast` 嵌套 5、
  `doAnalyze` 63 行/14 分支、`vim.register` 85 行）是下轮热点；覆盖率/变异测试未引入；
  Linux 切换仍走同步 `execFileSync`（改异步要动 `IPlatformAdapter` 契约）；
  单键盘状态漂移无自愈入口；macOS 无适配器。

---

### 修复

- **`src/extension.ts`**：`ASTAnalyzer` 实例注册进 `context.subscriptions`，扩展停用时
  释放 Tree / Query / Language / Parser 等 WASM 资源（此前 `dispose()` 从未被调用）；
  Vim 延迟重试的 `setTimeout` 同样纳入订阅，停用时清除
- **`tsconfig.json`**：补 `esModuleInterop`，`npx tsc --noEmit` 由 1 个错误变为 0 错误

### 变更（CodeScene 健康度清理，运行行为不变）

- **`src/ASTAnalyzer.ts`**：`WASM_FILE_MAPPING`、`COMMENT_QUERY`、函数体内每次调用重建的
  `lineCommentPatterns` 三张按语言平行的表合并为单一 `LANGUAGE_PROFILES`（新增语言只需改
  一处）；行/列区间判断与引号闭合判断抽为纯函数，降低核心检测函数的嵌套深度；删除空 `if`
  死分支
- **`src/platforms/linux/adapter.ts`**：`LinuxIMEManager` 接口收口（`queryModeAsync()`、
  `syncFromSystem()` 变为必选，`queryModeAsync` 不再把 `this.envPath` 当形参传入），删除
  `instanceof` 分派、`'syncFromSystem' in manager` 探测与 `as any` 强转；删除 4 个未被调用
  的 getter；`5000 / 1000` 魔数改为 `DETECT_TIMEOUT_MS / QUERY_TIMEOUT_MS`
- **`src/core/state-tracker.ts`**：删除只写不读的 `lastPositionChar`（`updatePosition(line)`
  签名收窄）；`notifyAutoSwitch()` 去掉恒真的冗余 `if`；修正文件头关于 `switchTo()` 调用顺序
  的过期注释
- **`src/core/controller.ts`**：`toggleIME()` 改为复用 `switchTo()`，删除与自动切换路径重复
  的中英文分支
- **`src/win32/ime-ffi.ts`**：删除未使用的 FFI 绑定与常量（`SendMessageW`、`ImmGetOpenStatus`、
  `ImmSetOpenStatus`、`IME_CMODE_ALPHANUMERIC`、与 `IME_CMODE_NATIVE` 同值的
  `IME_CMODE_CHINESE`）；`queryIMEMode()` 的嵌套三元展开为顺序判断；`keybd_event` 的 `0 / 2`
  改为具名 `KEYEVENTF_KEYDOWN / KEYEVENTF_KEYUP`
- **`src/platforms/windows/adapter.ts`**：`init()` 的策略分支改为早返回的扁平结构（保持原有
  各分支语义）；删除 `useDual()` / `DualKeyboardStrategy` 构造函数中形同虚设的 `ffi` 注入参数
- **`src/extension.ts`**：`require('fs') / require('path')` 改为顶部 `import`；日志文件初始化
  失败不再静默吞掉，改为在 logger 就绪后输出 `[Bootstrap]` 警告；`activate()` 拆出
  `activateInternal()`；Vim / Normal 两条监听器注册路径合并为 `registerModeListener()`；
  消除 `controller!` / `logger!` 非空断言与 `catch (e: any)`
- **`src/core/types.ts`**：删除未被引用的 `AnalysisResult` / `CursorContext`；修正提及已移除的
  Fcitx4、TSF 探测、`imm32` 切换方式的过期注释

### 验证

- `npx tsc --noEmit`：0 错误
- `node esbuild.js` / `npm run compile`：构建通过
- 四个 mock 测试全绿：`ast-analyzer-test` 59/59、`mock-linux-ime-test` 56/56、
  `mock-koffi-test` 30/30、`mock-tsf-test` 17/17（合计 162）
- 三张语言表合并前后用脚本逐键比对（15 个 languageId × wasmFile / query / lineComments），
  数据完全等价

> 注意：`test/ast-analyzer-test.js` 复现了一份 ASTAnalyzer 逻辑做独立测试，并不直接加载真实
> 源码，因此 `ASTAnalyzer.ts` 的数据表合并主要依赖上述逐键比对与构建验证，仍建议在真实 VS Code
> 中抽查注释/字符串判定。

### 变更（第二轮：结构重构，含行为修正）

#### 行为修正

- **`src/ASTAnalyzer.ts`**：修正快速路径的注释误判
  - CSS 无 `//` 行注释，旧配置会把 `url("http://…")` 一类文本误判为注释从而错误切到中文，
    现在 `lineComments: []`
  - 块注释标记不再对全语言硬编码 `/* */`：新增 `blockComments` 字段按语言声明，Python /
    Shell / HTML / Lua 设为 `null`（它们没有 `/* */` 注释，旧逻辑会在含 `/*` 的字符串/路径上误判），
    C 系语言仍为 `/* */`；`html` 的多行注释由 AST 路径兜底
  - 收益：无块注释的语言不再读整档文本（少一次 `document.getText()`）

#### 结构

- **`src/platforms/linux/adapter.ts`**：`Fcitx5Manager` / `IBusManager` 的重复实现（约 80 行）
  下沉到抽象基类 `CommandLineImeManager`，子类只提供“三条命令 + 日志文案”；所有日志文本与
  shell 命令逐字保留
- **`src/core/poller.ts`（新增）**：`ValuePoller` 统一“探针轮询 + 变化回调”，支持自适应间隔
- **消除双轮询 + 修正 Windows 检测**：
  - `IMEStateTracker` 不再自带 2s 兜底定时器（与适配器轮询重叠，同一状态被读两遍），
    `startListening()` 不再接间隔参数
  - Windows 双键盘的 Language ID 轮询从 tracker 下沉到 `WindowsAdapter`，`pollingInterval`
    配置现由适配器自己读取；单键盘明确返回“不可观察”，不再白转一圈
  - `IPlatformAdapter.startListening()` 的布尔返回值（`false` 表示“我自己轮询”→ 反直觉）
    改为具名枚举 `ExternalSwitchSource`（`adapter-polling` / `event-driven` / `not-observable`），
    并新增 `stopListening()` 由 `tracker.stopListening()` 统一回收
- **`src/extension.ts`**：去全局化 —— 模块级可变状态从 **8 个降到 1 个**（`session`）。
  一次激活的全部协作对象收进 `ActivationSession`（logger / adapter / tracker / controller /
  订阅列表 / Vim 标记 / 键盘警告标记），`deactivate()` 只调 `session.dispose()`；
  部分接线失败时会先 `dispose()` 再抛出，不会留下挂着的轮询定时器
- **`src/win32/ime-ffi.ts`**：删除未接线的 IMM32 转换状态通道（`queryIMEMode`、`setIMEMode`、
  `ImmGetContext` / `ImmReleaseContext` / `ImmGetConversionStatus` / `ImmSetConversionStatus`、
  `imm32.dll` 加载、`IME_CMODE_NATIVE`、`LRESULT` 别名）——VS Code 是 TSF-only 宿主，
  `ImmGetContext` 恒返回 0，该路径在本项自目标场景下读不到也写不动。如需支持非 VS Code 宿主，
  可从 `v0.9.0` tag 找回
- **`src/platforms/windows/single-keyboard.ts`**：删除无调用方的 `isAvailable()`；两个策略新增
  `observesExternalSwitches` 能力标记（双键盘 true，单键盘 false）
- **`src/platforms/windows/adapter.ts`**：三个配置读取器合并为 `readEnumConfig()` +
  `readPollingIntervalConfig()`
- **`src/core/types.ts`**：`startListening` 契约重写（见上）

#### 测试

- **修复 `test/mock-koffi-test.js` 用例跑器**：原来 `test()` 不 await 异步用例，“activate 可成功
  执行”这个唯一的端到端用例实际从未被判定（其内部异常被吞）。现改为收集 Promise、
  等全部完成后再汇总退出
- **`mock-koffi-test` 的 activate 用例升级为真实断言**：提供完整 `mockContext`（含
  `globalStorageUri`），断言无 FATAL、双键盘策略已选、`AST Analyzer initialized`、
  模式监听器已注册、外部切换检测已启动、`context.subscriptions` 数量
- **删除 7 个仅自测 mock 、且引用已删除 API 的用例**（IMM32 转换状态桩相关），改写
  `PostMessageW` / 布局枚举 / 切换流程 3 个同类型用例；`imm32` 桩与 `SendMessageW` 桩从 mock 中移除
- **新增 `mock-tsf-test` 用例**：双键盘 `startListening` 轮询 Language ID 并在外部切换时回调（16 → 17）
- **修正 mock 保真度**：`GetWindowThreadProcessId` 桩签名补齐 `_Out_`（之前与真实绑定不一致，
  静默落到 UNKNOWN 桩）；补上真实使用的 `PostMessageW` 桩
- 用例数 164 → 162；减少的是不接触产品代码的 mock 自测，产品代码覆盖只增不减

## [0.9.0] - 2026-09-08

### 概述

v0.9.0 补上 Windows「单键盘」场景：系统里只装了中文输入法（没有英语 1033 键盘
布局）时，旧的双键盘方案完全失效，只能打日志提示用户去装英语键盘。本版本实现
`SingleKeyboardStrategy`，通过向前台窗口注入 IME 切换热键（Shift / Ctrl+Space）在
同一个输入法内部切换中 / 英。

> **重要**：最初计划直接写 TSF 的 `GUID_COMPARTMENT_KEYBOARD_OPENCLOSE` 全局
> compartment，但真机实测（Windows 11 26200）证明该方案**无效**——IME 开/关状态是
> 线程/应用级的，而扩展宿主与编辑器渲染进程是两个不同进程，从宿主写全局 compartment
> 不会改变前台应用的输入法状态（写入后打字仍然组字）。因此最终改为「模拟 IME 切换
> 热键，让 IME 自己翻转」。详见下文「已知限制」。

### 新增

- **`src/platforms/windows/single-keyboard.ts`**：单键盘策略
  - 内部维护 `targetMode` 跟踪目标状态；`switchToEnglish()` / `switchToChinese()`
    同步返回 `{ success: true, method: 'toggle' }`，重复切换同一模式返回 `skip`
  - 通过 `keybd_event` 向前台窗口注入 IME 切换热键（默认 Shift，可配 Ctrl+Space）
- **`src/win32/ime-ffi.ts`**：新增 `sendImeToggle()`（keybd_event 注入切换热键）
- **`test/mock-tsf-test.js`**：16 条用例，覆盖单键盘分支、双键盘行为不变、
  显式配置、热键注入、注入失败健壮性

### 变更

- **`src/platforms/windows/adapter.ts`**：
  - 支持 `DualKeyboardStrategy | SingleKeyboardStrategy`
  - 新增 `auto-ime.windows.strategy`（`auto` / `dual-keyboard` / `single-keyboard`）
  - 新增 `auto-ime.windows.toggleKey`（`shift` / `ctrl-space`）
  - `startListening()` 返回 false（TSF-only 应用无跨进程读取，无法事件驱动监听）
- **删除（原 TSF compartment 管道方案，实测无效，整体移除）**：
  - `src/win32/tsf-ffi.ts`、`src/win32/tsf-pipe.ts`、`src/win32/tsf-bridge-csharp.ts`
  - `src/win32/tsf-helper.cs`（过时参考文件，与实现脱节）
- **文档**：README / README_EN 更新单键盘说明与配置项

### 已知限制

- **无跨进程读取**：对 TSF-only 应用（VS Code / Electron）`ImmGetContext` 返回 0，
  且 IME 开/关状态是线程/应用级的，扩展宿主无法读取渲染进程的真实状态。因此：
  - 只能靠内部跟踪 `targetMode` 判断是否要切换
  - 用户用鼠标/系统托盘手动切换会导致状态漂移，需手动 `auto-ime.toggleIME` 校正
- **切换是「翻转」而非「绝对设置」**：依赖输入法自己的切换热键，热键须与输入法
  设置一致（微软拼音 Win11 默认 Shift；其它输入法可能用 Ctrl+Space）
- **双键盘仍是默认推荐**：单键盘模式只在没有英语键盘布局时兜底
- 未适配 Linux（本次未触碰 `src/platforms/linux/`）

## [0.8.2-beta] - 2026-09-08

### 概述

v0.8.2-beta 是死代码与文档清理版本。v0.7.0 删除 Fcitx4 支持、v0.8.0 将状态追踪从
D-Bus 信号改为自适应轮询、v0.8.1 移除 dbus-next 依赖之后，仍有部分测试脚本和文档
未同步更新，本版本一并收尾。无功能变更。

### 删除

- **D-Bus 测试脚本（5 个）**：`test/dbus-signal-test.js`、`-v2.js`、`-v3.js`、
  `dbus-quick-check.js`、`dbus-automated-test.js`
  （v0.8.0 起架构改为自适应轮询，不再依赖 D-Bus 信号）
- **D-Bus 诊断脚本（2 个）**：`scripts/diagnose-dbus.js`、`scripts/diagnose-dbus-deep.js`
- **`package-lock.json` 中的 dbus-next 残留依赖树**：v0.8.1 仅从 `package.json` 摘除了
  `dbus-next`，lock 中仍保留其全部传递依赖（`xml2js`、`sax`、`request`、`sshpk`、
  `node-gyp`、`tar`、`npmlog`、`gauge`、`event-stream`、`hexy`、`usocket`、
  `@nornagon/put`、`long`、`jsbi` 等）。重新生成 lock 后包数由 142 降至 22。

### 修复

- **`scripts/check-env.js`**：
  - 移除 Fcitx4 检测段落与汇总条目（扩展自 v0.7.0 起不再支持 Fcitx4）
  - 两处告警文案仍提示「dbus-next 可能无法连接」，该依赖已于 v0.8.1 移除；
    改为说明自适应轮询不依赖 D-Bus，此项仅作环境诊断
- **`README.md` / `README_EN.md`**：手动安装示例仍写 `auto-ime-0.6.0.vsix`，更新为 `0.8.1`
- **`README_EN.md`**：移除已删除的 Fcitx4 支持说明；补齐「外部切换检测」步骤，与中文版一致
- **`CONTRIBUTING.md`**：
  - 项目结构与核心模块章节描述的 `IMEManager.ts`、`IMEStateManager.ts` 已不存在，
    按 `core/` / `modes/` / `platforms/` 现状重写
  - Mock 测试用例数 70 / 26 更新为实际值 56 / 39，并补充 AST 测试（59 用例）
  - 移除 `dbus-next`、Fcitx4 相关描述

### 测试

- `node test/mock-koffi-test.js`：39/39 通过
- `node test/mock-linux-ime-test.js`：56/56 通过
- `node test/ast-analyzer-test.js`：59/59 通过
- `npm run compile`：编译成功，无 TypeScript 错误

## [0.8.1-beta] - 2026-06-07

### 概述

v0.8.1-beta 清理了废弃的 D-Bus 相关代码和依赖，减小包体积，消除安全警告。

### 删除

- **dbus-listener.ts**：已废弃的 D-Bus 信号监听模块（自适应轮询方案不依赖它）
- **dbus-next 依赖**：已从 node_modules 中移除（包体积减小 ~150KB）

### 测试

- 编译成功，无 TypeScript 错误
- Linux mock 测试：56/56 通过
- dist/ 中无 dbus-next 残留

## [0.8.0-beta] - 2026-06-06

### 概述

v0.8.0-beta 是 Linux 平台状态追踪的重大改进版本。通过实际 D-Bus 信号测试发现，
Fcitx5 不会为远程切换（fcitx5-remote）发出 InputContext 信号，因此将状态追踪机制
从 D-Bus 事件驱动改为自适应轮询，确保可靠检测用户手动切换输入法。

### 重大变更

- **状态追踪机制重构**：从 D-Bus 事件驱动改为自适应轮询
  - 经过完整的 D-Bus 信号测试（dbus-monitor），确认 Fcitx5 不发出 InputContext 信号
  - 使用异步轮询替代同步轮询，完全消除主线程阻塞
  - 自适应间隔：活动状态 100ms，空闲状态 500ms

### 新增

- **自适应轮询机制**：
  - `runBashAsync()`：异步执行 shell 命令，不阻塞主线程
  - `queryModeAsync()`：异步查询当前输入法状态
  - `AdaptivePollConfig`：可配置的轮询间隔参数
  - 活动状态检测延迟 ~100ms，空闲状态 ~500ms
- **D-Bus 诊断脚本**：
  - `scripts/diagnose-dbus.js`：基础 D-Bus 环境检测
  - `scripts/diagnose-dbus-deep.js`：深度 D-Bus 信号分析
- **D-Bus 信号测试脚本**：
  - `test/dbus-signal-test.js`：信号监听测试
  - `test/dbus-signal-test-v2.js`：改进版测试
  - `test/dbus-signal-test-v3.js`：Portal 路径测试
  - `test/dbus-quick-check.js`：快速连接检测
  - `test/dbus-automated-test.js`：自动化切换测试

### 优化

- **消除主线程阻塞**：
  - 旧方案：`execFileSync` 同步执行，每次阻塞 7-16ms
  - 新方案：`exec` 异步执行，0% 阻塞
- **智能轮询间隔**：
  - 检测到输入法变化后保持高频轮询（100ms）
  - 5 秒无变化后降频到空闲轮询（500ms）
  - 平衡响应速度和 CPU 占用
- **代码清理**：
  - `dbus-listener.ts` 标记为 `@deprecated`，保留供未来参考
  - 移除 `LinuxAdapter` 中的 D-Bus 相关代码

### 技术发现

通过实际测试发现的关键问题：

1. **Fcitx5 D-Bus 信号问题**：
   - `dbus-monitor` 显示只有 method call（SetCurrentIM、Toggle），没有 signal
   - InputContext 信号只在当前活跃的 InputContext 中触发
   - 通过 `fcitx5-remote` 命令切换不会触发信号

2. **Fcitx5 D-Bus 路径**：
   - 旧路径 `/inputmethod` 不存在
   - 正确路径：`/org/freedesktop/portal/inputmethod`
   - Controller1 接口：`/controller`

3. **性能对比**：
   | 方案 | 阻塞 | 延迟 | CPU 占用 |
   |------|------|------|----------|
   | 同步轮询 | 5-15% | 100ms | 低 |
   | 异步轮询 | 0% | 100ms | 低 |
   | 自适应轮询 | 0% | 100-500ms | 最低 |

### 测试

- Linux mock 测试：56/56 通过
- 编译成功，无 TypeScript 错误
- Bundle 验证：包含自适应轮询相关代码

## [0.7.0] - 2026-06-05

### 概述

v0.7.0 是 Linux 平台的性能和架构优化版本。引入 D-Bus 事件驱动机制替代轮询，
实现即时检测用户手动切换输入法，同时完全消除编辑器卡顿。删除已废弃的 Fcitx4 支持。

### 新增

- **D-Bus 事件驱动监听**：新增 `src/platforms/linux/dbus-listener.ts`，统一 Fcitx5 和 IBus 的 D-Bus 信号监听
  - Fcitx5: 监听 `org.fcitx.Fcitx5.Controller1.InputMethodChanged` 信号
  - IBus: 监听 `org.freedesktop.IBus.GlobalEngineChanged` 信号
  - 信号到达即时回调，无轮询延迟，无子进程开销
- **IPlatformAdapter.startListening()**：新增事件驱动监听接口，平台适配器可注册外部切换回调
- **StateTracker 事件驱动模式**：Linux 使用 D-Bus 信号，Windows 使用轮询兜底

### 优化

- **Linux 不再轮询**：D-Bus 信号替代 500ms 轮询，检测延迟从 500ms 降到即时
- **内部状态追踪**：`queryMode()` 返回内部变量（<0.01ms），不调用子进程
- **跳过冗余切换**：`switchToXxx()` 目标相同时返回 `skip`，不执行 `execSync`
- **统一状态更新**：`switchTo()` 先更新 `currentIME` 再执行切换，D-Bus 回声自动过滤
- **D-Bus 回声过滤**：我们的切换触发的 D-Bus 信号通过 `currentIME` 一致性检查自动跳过
- **日志系统优化**：
  - 移除 `queryIMEMode` 每次调用的 debug 日志
  - `setIMEMode` ImmGetContext 失败不再输出日志（TSF 下已知会失败）
  - `No WASM mapping` 每个 languageId 只输出一次
  - ESC/toggle 后 poll 不再误判为 Manual switch

### 删除

- **Fcitx4 支持**：已废弃的输入法框架，用户应迁移到 Fcitx5
  - 删除 `Fcitx4Manager` 类
  - 删除 `fcitx-remote` 命令调用
  - 检测链简化为：Fcitx5 → IBus → 不可用

### Bug 修复

- **修复初始化竞态**：`extension.ts` 激活时 `adapter.switchToEnglish()` 后添加 `stateTracker.notifyAutoSwitch('en')`，防止首次光标事件被误判为手动切换
- **修复 D-Bus 通知后 adapter 状态未同步**：`handleExternalSwitch` 中调用 `adapter.syncState()` 同步内部状态
- **修复 ESC/toggle 后 poll 误判**：`forceEnglish()` 和 `toggleIME()` 添加 `notifyAutoSwitch()` 调用
- **修复 suppress 窗口未更新 currentIME**：自动切换的回声正确更新状态
- **删除死代码**：`stateTracker.getCurrentIME()` 从未被调用

### 测试

- Linux mock 测试：56/56 通过
- Windows mock 测试：39/39 通过
- 新增 D-Bus 相关 bundle 验证（DbusIMEListener、FCITX5_DBUS、IBUS_DBUS、信号名）

## [0.6.0] - 2026-06-04

### 概述

v0.6.0 是 Windows 平台适配的重大版本。从零开始实现了基于 koffi FFI 的原生 Win32 API 调用，
替代了之前缓慢的 PowerShell 方案。同时对整个项目进行了模块化重构，解耦了分析、切换、平台适配三层逻辑。

### Windows 适配

#### 新增
- **koffi FFI 基础层**：通过 koffi（Node.js FFI）直接调用 `user32.dll` / `imm32.dll` / `kernel32.dll`，替代 PowerShell 方案
- **双键盘切换方案**：英语键盘(1033) ↔ 微软拼音键盘(2052)，通过 `PostMessageW(WM_INPUTLANGCHANGEREQUEST)` 切换
- **Language ID 查询**：通过 `GetKeyboardLayout` 获取当前键盘布局的 Language ID，判断中英文状态
- **内部状态追踪**：`currentLayout` 字段追踪目标布局，避免 `PostMessageW` 异步导致的状态不一致
- **TSF 持久化管道**：`tsf-pipe.ts` 通过持久化 PowerShell 进程与 TSF COM compartment 通信（~5ms）
- **TSF 检测**：通过 `ole32.dll` COM 函数检测 `MsTf.TF_ThreadMgr` 可用性
- **英语键盘缺失引导**：未安装英语(美国)键盘时弹出 VS Code 信息提示
- **可配置轮询间隔**：`auto-ime.windows.pollingInterval`（默认 150ms，范围 50-1000）
- **窗口焦点同步**：窗口重新获得焦点时同步 IME 状态

#### 已知限制
- 当前使用"双键盘"方案，需要系统安装英语(美国)键盘
- IMM32 对微软拼音等 TSF 输入法无效（`ImmGetContext` 返回 null），已从切换路径中移除
- TSF compartment 读写依赖 PowerShell COM 互操作，部分精简版 Windows 可能不可用
- 单键盘方案（微软拼音内部中英切换）尚未实现，需要 TSF COM 可用后才能开发

### 模块化重构

#### 新增架构
```
src/
├── core/                          # 平台无关的核心逻辑
│   ├── types.ts                   # 接口定义（IPlatformAdapter, IModeListener）
│   ├── controller.ts              # 主控制器：分析 → 切换调度
│   └── state-tracker.ts           # IME 状态追踪（轮询、手动/自动切换检测）
├── modes/                         # 模式特定行为
│   ├── normal.ts                  # 普通编辑器模式监听器
│   └── vim.ts                     # Vim 模式监听器（ESC、Insert/Normal 检测）
├── platforms/                     # 平台实现
│   ├── index.ts                   # 平台工厂（自动检测 Linux/Windows）
│   ├── linux/adapter.ts           # Linux 适配器（Fcitx5/4/IBus）
│   └── windows/
│       ├── adapter.ts             # Windows 适配器
│       └── dual-keyboard.ts       # 双键盘策略
├── extension.ts                   # 入口（薄层 ~170 行）
├── ASTAnalyzer.ts                 # Tree-sitter AST 分析器
└── logger.ts                      # 统一日志模块
```

#### 关键改进
- `extension.ts` 从 477 行精简到 170 行
- 平台逻辑完全隔离（改 Windows 不影响 Linux）
- Vim 模式逻辑集中在 `modes/vim.ts`
- 通过接口解耦，可独立测试各模块

### Bug 修复

- **修复 `GetWindowThreadProcessId` 返回值误用**：返回值是 Thread ID，输出参数是 Process ID。修正了 `getTrueForegroundWindow` 和 `getCurrentLanguageId` 中的使用
- **修复字符串仍然自动切换**：Tree-sitter query 把注释和字符串都捕获为 `@comment`，修改为 `@comment` + `@string` 分开捕获
- **修复 Vim Normal 模式输入法不切英文**：`switchToEnglish` 跳过检查不可靠（Language ID 已是 1033 但 IME 内部仍为中文），改为始终执行切换
- **修复切换后状态不一致**：`PostMessageW` 是异步的，`getCurrentLanguageId` 读到旧状态。改用内部 `currentLayout` 字段追踪
- **修复状态栏不显示**：重构时漏了 `statusBarItem.show()` 调用
- **修复首次启动不切换到英文键盘**：`updateStatusBar('en')` 只改显示，不切键盘。添加 `adapter.switchToEnglish()` 调用
- **修复 analyzeAndSwitch 双重触发**：添加 generation 计数器
- **修复 Code Runner 输出面板触发分析**：在入口处检查 `document.uri.scheme`
- **修复日志洪水**：移除高频 debug 日志，queryMode 失败日志改为首次 INFO + 每 30s DEBUG

### 优化

- **方案 A：只在注释中自动切换中文**：字符串中不干预当前输入法状态
- **TSF pipe 不可用缓存**：首次检测不可用后跳过后续尝试
- **混合轮询**：自动切换后 600ms suppress 窗口，轮询间隔 150ms
- **乐观更新**：先 `updateStatusBar` 再 `switchToXxx`，避免重复触发
- **动态防抖**：根据文件行数调整延迟（<500 行: 10ms / 500-5000 行: 30ms / >5000 行: 60ms）
- **Tree-sitter 增量解析**：大文件解析速度提升约 3 倍
- **解析取消机制**：快速光标移动时自动丢弃过期结果

### 测试

- Windows mock 测试：39/39 通过
- 覆盖 koffi FFI 调用、切换流程、TSF 管道、模块化架构

## [0.5.0] - 2026-06-03

### 新增
- 普通模式支持：未安装 Vim 扩展的用户可直接使用
- Vim 延迟检测：通过光标样式双向验证（Block + isActive）自动识别
- 手动覆盖恢复：用户手动切换后自动暂停分析，光标移动后恢复

### 修复
- 修复普通模式下手动切换后自动分析被永久暂停的问题
- 修复 `toggleIME` 错误调用 `markAutoSwitch` 导致轮询误判

## [0.4.0] - 2026-06-02

### 新增
- Windows 平台支持：通过 PowerShell + Win32 API 切换键盘布局
- 扩展语言支持：Lua、Java、Kotlin、Bash

## [0.3.0] - 2026-06-02

### 新增
- 基于文本的快速注释检测（`isCursorInCommentFast`）
- AST 分析仅在快速路径不确定时执行

## [0.2.0] - 2025-01-01

### 新增
- 状态栏显示当前输入法状态
- 点击状态栏可手动切换
- 支持 TSX/JSX

## [0.1.0] - 2024-01-01

### 新增
- 初始版本
- 基于 Tree-sitter AST 的上下文检测
- 支持 JavaScript、TypeScript、Python、Go、Rust、C、C++、CSS
- ESC 键强制切换到英文
- 自动检测 Fcitx5/Fcitx4/IBus

[0.6.0]: https://github.com/CI124/auto-ime/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/CI124/auto-ime/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CI124/auto-ime/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CI124/auto-ime/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CI124/auto-ime/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CI124/auto-ime/releases/tag/v0.1.0
