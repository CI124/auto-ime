# 更新日志

本项目所有重要变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.6-beta] - 2026-06-04

### 修复
- **P0: 修复 analyzeAndSwitch 双重触发**：添加 generation 计数器，selection 和 document 事件共享同一个 debounce timer，后到的事件会覆盖前一个，确保 analyzeAndSwitch 只执行一次
- **P1: 过滤非代码文件**：在 analyzeAndSwitch 入口处检查 `document.uri.scheme`，只处理 `file` 和 `untitled` scheme，跳过 Code Runner 输出面板、diff 视图等无意义分析
- **P2: 增强 TSF 检测日志**：IMESwitcher 初始化时输出键盘布局十六进制值、TSF COM 对象可用性、TSF pipe 状态；异步切换方法添加 tsf-pipe 尝试/成功/失败的详细日志

### 优化
- **TSF pipe 不可用缓存**：首次检测 TSF COM 对象不可用后，后续异步切换直接跳过 TSF pipe 尝试，避免首次 1220ms 超时和后续无意义调用
- **混合轮询方案**：自动切换完成后设置 600ms suppress 窗口，窗口内跳过轮询 FFI 查询；轮询间隔从 500ms 降至 150ms（手动切换检测更快）
- **切换感知延迟**：自动切换从 ~400ms 降至 ~0ms（suppress 窗口内不触发轮询）；手动切换检测从 ~500ms 降至 ~150ms
- `scheduleAnalyze` 使用 generation 计数器，避免 selection + document 事件各触发一次导致 analyzeAndSwitch 执行两次
- 新增 `getTSFPipeStatus()` 导出方法，用于运行时诊断 TSF 管道状态

### 验证
- Windows mock 测试：40/40 通过
- Bundle 确认包含 TSF 缓存、suppress 窗口、150ms 轮询间隔

## [0.6.5-beta] - 2026-06-04

### 修复
- **修复切换重复触发**：`analyzeAndSwitch` 改为乐观更新（先 `updateStatusBar` 再 `await switchAsync`），避免异步切换期间 `currentIMEMode` 未更新导致重复触发（~70 次重复 → 1 次）
- **移除 `setIMEMode` ImmGetContext 失败日志**：TSF IME 下已知会失败，由调用方处理降级，不再每次输出 DEBUG 日志
- **`No WASM mapping` 日志去重**：每个未映射的 languageId 只输出一次，不再每次 document change 都重复

### 预期效果
- `switch to ZH` 从 ~70 次重复降为 1 次
- `setIMEMode: ImmGetContext failed` 从每次切换都输出降为 0 次
- `No WASM mapping for code-runner-output` 从 ~200 次降为 1 次

## [0.6.4-beta] - 2026-06-04

### 新增
- **异步切换集成到主路径**：`analyzeAndSwitch` 现在优先使用 `switchToChineseAsync`/`switchToEnglishAsync`（TSF 管道 ~5ms），不可用时降级到同步方法
- **IIMEManager 接口扩展**：新增可选的 `switchToChineseAsync`/`switchToEnglishAsync` 方法，Windows 平台自动实现

### 优化
- ESC 和状态栏手动切换仍使用同步路径（用户操作场景延迟可接受）
- 自动切换（光标上下文分析）使用异步路径（TSF 管道，无阻塞）

### 验证
- Windows mock 测试：40/40 通过
- Linux mock 测试：70/70 通过
- Bundle 确认包含 7 处 `switchToChineseAsync` + 5 处 `switchToEnglishAsync` 调用

## [0.6.3-beta] - 2026-06-04

### 修复
- **修复 `queryIMEMode` Language ID 兜底永远失败**：`GetWindowThreadProcessId` 返回值是 Thread ID，但代码把输出参数 `pidBuf[0]`（Process ID）传给了 `GetKeyboardLayout`。修正为使用返回值作为 Thread ID
- **修复 `getTrueForegroundWindow` 线程附加使用错误 ID**：同上，`AttachThreadInput` 应使用 Thread ID 而非 Process ID
- **修复 DEBUG 日志洪水**：移除 `queryIMEMode` 每次调用的 FFI debug 日志；`queryMode` 失败日志改为首次 INFO + 之后每 30 秒 DEBUG 节流
- **修复 Debounce 日志噪声**：移除 `scheduleAnalyze` 中每次事件触发的 debug 日志
- **修复 esbuild.js 编码损坏**：中文注释改为英文，避免 PowerShell 环境下编码崩溃

## [0.6.2-beta] - 2026-06-04

### 新增
- **统一日志模块**：新增 `src/logger.ts`，提供 `createLogger(tag, outputChannel?, logFilePath?, minLevel?)` 工厂函数，统一写入 console + VSCode Output Channel + 日志文件
- **四级日志**：`debug` / `info` / `warn` / `error`，支持最低级别过滤，格式统一为 `[ISO-timestamp] [LEVEL] [TAG] message`
- **FFI 诊断日志**：`ime-ffi.ts` 所有关键函数（`queryIMEMode`、`setIMEMode`、`enumerateKeyboardLayouts`、`switchKeyboardLayout`）添加可选 logger 参数和 debug 日志
- **全面日志覆盖**：所有 silent catch 块、dispose/shutdown 路径、skip/none 分支均已添加日志

### 优化
- **删除 5 处重复 LogSink 定义**：所有文件统一从 `src/logger.ts` 导入
- **ASTAnalyzer 接入文件日志**：从接收 raw OutputChannel 改为接收 LogSink，AST 错误现在也写入日志文件
- **NullIMEManager 不再静默**：no-op 调用现在输出 debug 日志
- **日志语言统一**：所有中文日志消息改为英文
- **deactivate 日志**：扩展关闭时记录日志
- **Windows mock 测试**：40/40 通过

## [0.6.1-beta] - 2026-06-04

> **⚠ 实验性版本**：Windows 平台 TSF 持久化管道已就绪，需实机验证微软拼音单键盘切换。

### 新增
- **TSF 持久化管道**：新增 `src/win32/tsf-pipe.ts`，通过持久化 PowerShell 进程与 stdin/stdout 通信协议，将 TSF compartment 读写从 ~300ms 降至 ~2-5ms
- **异步切换方法**：`IMESwitcher` 新增 `switchToEnglishAsync()` / `switchToChineseAsync()`，完整三层策略：IMM32 → TSF pipe → 键盘布局切换
- **Language ID 兜底查询**：`queryIMEMode()` 在 IMM32 失败时自动用 `GetKeyboardLayout` 的 Language ID 判断中英文，无需 TSF 回退
- **英语键盘缺失引导**：检测到未安装英语(美国)键盘时，弹出 VS Code 信息提示并提供"打开设置"按钮（`ms-settings:regionlanguage`），每会话仅弹一次
- **TSF 异步 API**：`tsf-ffi.ts` 新增 `queryTSFModeAsync()` / `setTSFModeAsync()` / `disposeTSFPipe()`

### 优化
- **查询性能提升**：`queryMode()` 移除 TSF PowerShell 回退（~300ms），改为 Language ID 兜底（<1ms）
- **轮询间隔调整**：默认从 1000ms 降至 500ms，手动切换检测更灵敏（配置范围同步调整为 50-1000ms）
- **测试覆盖扩展**：Windows mock 测试从 29 个增至 40 个，新增 TSF 管道协议、异步方法、用户引导等验证

### 已知问题
- 异步切换方法 (`switchToEnglishAsync`/`switchToChineseAsync`) 尚未集成到 `extension.ts` 的主切换路径，需实机验证后启用
- TSF 管道依赖 PowerShell COM 互操作 `MsTf.TF_ThreadMgr`，部分精简版 Windows 可能不可用

### 待办
- 实机验证：在 Windows + 微软拼音环境下测试 TSF 管道的单键盘内中英切换
- 集成异步切换：验证成功后将 `analyzeAndSwitch` 改为使用异步方法
- 长期：用预编译 C++ DLL 替代 PowerShell 管道，进一步降低延迟到 <1ms

## [0.6.0-beta] - 2026-06-04

> **⚠ 实验性版本**：Windows 平台已实机测试，核心功能可用，性能和稳定性仍在优化中。

### 新增
- **ASTAnalyzer 单元测试**：新增 `test/ast-analyzer-test.js`（59 个用例），覆盖 TypeScript/Python/C++ 三种语言
  - 光标在普通代码/单行注释/多行注释/字符串/模板字符串内的检测
  - 快速文本启发式 (`isCursorInCommentFast`) 全路径验证
  - 两阶段检测管道一致性验证
  - QueryCache 缓存行为验证
  - 大文件性能基准（5000 行解析 < 2000ms）
  - 增量解析与取消机制验证
  - 边界情况（空文件、注释起始边界、字符串引号边界）

### 新增
- **Linux 平台 Mock 测试**：新增 `test/mock-linux-ime-test.js`（70 个用例），覆盖 Fcitx5Manager、Fcitx4Manager、IBusManager 的完整行为
  - 三种 IME 管理器的查询/切换命令验证
  - 责任链降级测试（Fcitx5 → Fcitx4 → IBus → NullManager）
  - 超时与异常安全测试（fcitx5-remote/fcitx-remote/ibus engine 超时不阻塞主线程）
  - profile 文件边界情况（不存在、空文件、格式异常、自定义输入法列表）
  - IMEStateManager 内部逻辑验证（500ms 阈值、手动覆盖、光标跟踪）
  - D-Bus / dbus-next 容错验证
  - 平台隔离验证（win32 守卫、FFI 懒加载、Linux 探测命令）
- **环境检测脚本**：新增 `scripts/check-env.js`，自动检测本地 Linux 输入法环境
  - 检测 Fcitx5/Fcitx4/IBus 安装状态和守护进程连通性
  - 测试 fcitx5-remote、fcitx-remote、ibus 命令可用性
  - 验证 D-Bus session daemon 连通性
  - 解析 Fcitx5 profile 中已配置的输入法列表
  - `npm run check-env` 可独立运行，`npm run compile`/`npm run watch` 前自动执行
- **依赖锁文件**：`package-lock.json` 纳入版本控制（从 .gitignore 移除）
- **koffi FFI 基础层**：用 koffi（Node.js FFI）直接调用 `user32.dll` / `imm32.dll` / `kernel32.dll`，替代 PowerShell 方案
- **IMM32 兼容层**：通过 `ImmGetConversionStatus` / `ImmSetConversionStatus` 直接读写输入法中英文模式
- **TSF 检测**：通过 koffi 调用 `ole32.dll` COM 函数检测 TSF 输入法（如微软拼音）
- **三层切换策略**：IMM32 → TSF → 键盘布局切换（`WM_INPUTLANGCHANGEREQUEST`），自动降级
- **多语言支持**：新增繁体中文(台湾1028/香港3076/澳门5124)和新加坡中文(4100)
- **窗口焦点恢复**：`onDidChangeWindowState` 监听，窗口重新获得焦点时同步 IME 状态
- **光标样式事件**：`onDidChangeTextEditorOptions` 监听，Vim 模式 Insert↔Normal 切换检测更精确
- **可配置轮询间隔**：新增 `auto-ime.windows.pollingInterval` 配置项（默认 1000ms，范围 50-500）
- **PowerShell 回退**：koffi 加载失败时自动降级到 PowerShell 方案（临时 .ps1 文件 + `-File` 参数）
- **统一日志系统**：VSCode 输出面板和日志文件同步写入，内容完全一致
- **智能切换检查**：切换前先查询当前模式，相同则跳过，避免重复切换
- **指数退避恢复**：PowerShell 连续失败后暂停 5s→10s→20s→40s，自动恢复重试
- **全局错误捕获**：`activate` 函数 try/catch，崩溃信息写入日志文件

### 修复
- **修复 koffi `GetCurrentThreadId` 加载失败**：从 `user32.dll` 改为 `kernel32.dll`（该函数实际在 kernel32 中）
- **修复 koffi BigInt 类型混用**：所有 Win32 API 返回值添加显式 `BigInt()` / `Number()` 转换
- **修复 koffi `_Out_` 参数缺失**：`GetWindowThreadProcessId` 和 `ImmGetConversionStatus` 的输出参数添加 `_Out_` 注解
- **修复 `queryIMEMode()` 永远返回字符串**：IMM32 失败时返回 `null`，由调用方决定回退策略
- **修复 `queryMode()` 隐藏轮询停止**：不再将 `''` 强制转为 `'en'`
- **修复 PowerShell `-EncodedCommand` 编码失败**：改用写临时 `.ps1` 文件 + `-File` 参数执行
- **修复 PowerShell 连续失败后永久停止**：改为指数退避（5s→40s），自动恢复
- **修复 WASM 文件路径错误**：`out/wasm/` → `dist/wasm/`
- **修复日志递归调用**：`log(msg)` 误调自身导致栈溢出
- **修复切换阻塞 400-800ms**：`SendMessageW`（同步）→ `PostMessageW`（异步）
- **修复 TSF PowerShell 阻塞**：跳过 `setTSFMode`（内部调用 PowerShell 同步阻塞 ~300ms）

### 优化
- **Tree-sitter 增量解析**：`parser.parse(text, lastTree)` 替代全量解析，大文件解析速度提升约 3 倍
- **解析取消机制**：`analysisGeneration` 计数器自动丢弃过期解析结果，避免快速光标移动时资源浪费
- **动态防抖**：根据文件行数自动调整延迟（<500 行: 10ms / 500-5000 行: 30ms / >5000 行: 60ms）
- **Python 字符串检测修复**：Python Query 简化为 `(comment) + (string)`，修复普通字符串（非文档字符串）漏检问题
- **资源管理**：新增 `ASTAnalyzer.dispose()` 释放 Tree/Query/Language/Parser 对象，防止内存泄漏
- **构建修复**：esbuild 添加 `debug` 到 external 列表，解决 `usocket` 传递依赖构建失败
- 日志精简：删除 `[ModeDetect]`、`[Escape]`、`[AST] Language cache is null` 等高频噪音日志
- 日志增强：`analyzeAndSwitch` 输出光标位置、语言、Vim 模式、检测结果、切换动作
- 日志增强：`ime-switcher` 输出切换方法和耗时
- 轮询间隔从 500ms 调整为 1000ms，降低 CPU 占用
- 每次启动清空旧日志文件

### 已知问题
- 当前使用"双键盘"方案（英语键盘1033 ↔ 中文键盘2052），非单键盘内中英文切换
- IMM32 对微软拼音等 TSF 输入法无效（`ImmGetContext` 返回 null），降级到键盘布局切换
- TSF compartment 读写依赖 PowerShell（~300ms），已从切换路径中跳过

### 待办
- 性能优化：当前双键盘方案每次切换仍有一定延迟，需进一步优化
- 单键盘切换：研究 `im-select` 源码，借鉴 TSF COM 实现真正的单键盘内中英文切换
- TSF 原生支持：编写 C++ DLL 封装 TSF COM 接口，通过 koffi 调用，替代 PowerShell

## [0.5.0] - 2026-06-03

### 新增
- **普通模式支持**：未安装 Vim 扩展的用户可直接使用，全局分析注释/字符串区域并自动切换输入法
- **Vim 延迟检测**：通过光标样式双向验证（Block + isActive）自动识别 Vim 扩展延迟加载，支持运行时自动切换模式
- **手动覆盖恢复**：用户手动切换输入法后自动暂停分析，光标移动到不同行或 Vim 按 ESC 后恢复

### 优化
- **分析调度合并**：selection/document 两个 debounce 合并为统一 10ms 调度，消除双重分析竞争
- **轮询检测修复**：checkModeChange 不依赖 lastCursorStyle，避免频繁 ESC→i 切换时漏检
- **构建输出重构**：编译产物统一输出到 `dist/` 目录，项目结构更清晰

### 修复
- 修复普通模式下在注释中手动切换输入法后自动分析被永久暂停的问题
- 修复 `toggleIME` 错误调用 `markAutoSwitch` 导致轮询误判手动切换为自动切换
- 修复 Vim `i` 键进入 Insert 模式后输入法未自动切换的问题
- 修复 Normal 模式下事件监听器与 Vim 模式互相干扰的问题

### 待办
- Windows 平台实际测试适配（当前仅 Linux 已验证）

## [0.4.0] - 2026-06-02

### 新增
- **Windows 平台支持**：通过 PowerShell + Win32 API (`SendMessageW(WM_INPUTLANGCHANGEREQUEST)`) 切换键盘布局
- **扩展语言支持**：新增 Lua、Java、Kotlin、Bash 四种语言的 AST 分析
- **切换前查询优化**：自动切换前检查当前输入法状态，已是目标状态时跳过执行，减少不必要的进程启动

### 优化
- **AST 分析重构**：用 tree-sitter Query API 替代手动节点遍历，代码更简洁、新增语言更方便
- 为每种语言使用声明式 `.scm` 查询模式捕获注释和字符串节点
- Query 对象编译后缓存，避免重复编译开销

### 修复
- 更新 README 中的语言支持表，补充 HTML、Lua、Java、Kotlin、Bash

## [0.3.0] - 2026-06-02

### 新增
- 基于文本的快速注释检测（`isCursorInCommentFast`），输入 `//`、`#` 等注释语法时即时响应，无需等待 AST 解析
- 文档变化与选择变化使用独立防抖定时器，避免事件竞争
- AST 边界回退逻辑增强，向前最多回退 4 列

### 修复
- **修复输入 `//` 后输入法未立即切换的问题**：根因是防抖回调中捕获的 `editor` 引用可能过时，且两个事件源共享同一防抖定时器导致竞争条件。现在防抖回调中实时读取 `vscode.window.activeTextEditor`，文档变化事件使用 30ms 独立防抖

### 优化
- 文档变化防抖从 50ms 降低到 30ms，输入响应更快
- 注释检测优先走同步快速路径，AST 分析仅在快速路径不确定时执行

## [0.2.0] - 2025-01-01

### 新增
- 状态栏显示当前输入法状态（`EN` / `中`）
- 点击状态栏可手动切换输入法
- 快捷键 `Ctrl+Shift+Space` 手动切换输入法
- 支持 TypeScript React (`.tsx`) 和 JavaScript React (`.jsx`)
- 文档变化监听，输入 `//` 时自动触发切换
- 光标在文本末尾时的回退检测逻辑

### 修复
- 修复增量解析在 WASM 中不更新 AST 的问题（改用全量解析）
- 修复根节点比较使用对象引用而非类型比较的问题
- 修复 Go 语言 `interpreted_string_literal` 节点类型
- 修复 C++ 语言 `string_content` 节点类型
- 修复注释开头位置检测逻辑

### 优化
- 防抖时间从 150ms 降低到 50ms
- 移除冗余日志输出
- 简化 IME 切换脚本

## [0.1.0] - 2024-01-01

### 新增
- 初始版本
- 基于 Tree-sitter AST 的上下文检测
- 支持 JavaScript、TypeScript、Python、Go、Rust、C、C++、CSS
- ESC 键强制切换到英文
- 自动检测 Fcitx5/Fcitx4/IBus
- 300ms 防抖响应

[0.6.5-beta]: https://github.com/CI124/auto-ime/compare/v0.6.4-beta...v0.6.5-beta
[0.6.4-beta]: https://github.com/CI124/auto-ime/compare/v0.6.3-beta...v0.6.4-beta
[0.6.3-beta]: https://github.com/CI124/auto-ime/compare/v0.6.2-beta...v0.6.3-beta
[0.6.2-beta]: https://github.com/CI124/auto-ime/compare/v0.6.1-beta...v0.6.2-beta
[0.6.1-beta]: https://github.com/CI124/auto-ime/compare/v0.6.0-beta...v0.6.1-beta
[0.6.0-beta]: https://github.com/CI124/auto-ime/compare/v0.5.0...v0.6.0-beta
[0.5.0]: https://github.com/CI124/auto-ime/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CI124/auto-ime/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CI124/auto-ime/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CI124/auto-ime/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CI124/auto-ime/releases/tag/v0.1.0
