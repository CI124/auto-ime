# 更新日志

本项目所有重要变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.0-beta] - 2026-06-04

> **⚠ 实验性版本**：Windows 平台已实机测试，核心功能可用，性能和稳定性仍在优化中。

### 新增
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

[0.6.0-beta]: https://github.com/CI124/auto-ime/compare/v0.5.0...v0.6.0-beta2
[0.5.0]: https://github.com/CI124/auto-ime/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CI124/auto-ime/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CI124/auto-ime/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CI124/auto-ime/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CI124/auto-ime/releases/tag/v0.1.0
