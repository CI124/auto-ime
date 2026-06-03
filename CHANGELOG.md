# 更新日志

本项目所有重要变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.0-beta] - 2026-06-03

> **⚠ 实验性版本**：以下所有变更均未在 Windows 实机上验证，仅在 Linux 上通过构建和逻辑审查。请谨慎使用，欢迎反馈问题。

### 新增
- **koffi FFI 基础层**：用 koffi（Node.js FFI）直接调用 `user32.dll` / `imm32.dll`，替代 PowerShell 方案，理论性能从 ~100ms 提升到 <1ms
- **IMM32 兼容层**：通过 `ImmGetConversionStatus` / `ImmSetConversionStatus` 直接读写输入法中英文模式，支持搜狗/百度等 IMM32 输入法
- **TSF 检测**：通过 koffi 调用 `ole32.dll` COM 函数检测 TSF 输入法（如微软拼音）
- **TSF compartment 读写**：通过 PowerShell COM 互操作访问 `ITfCompartment`，作为 IMM32 失败时的降级路径
- **三层切换策略**：IMM32 → TSF compartment → 键盘布局切换，自动降级
- **多语言支持**：新增繁体中文(台湾1028/香港3076/澳门5124)和新加坡中文(4100)的 Language ID 支持
- **窗口焦点恢复**：`onDidChangeWindowState` 监听，窗口重新获得焦点时同步 IME 状态
- **光标样式事件**：`onDidChangeTextEditorOptions` 监听，Vim 模式 Insert↔Normal 切换检测更精确
- **可配置轮询间隔**：新增 `auto-ime.windows.pollingInterval` 配置项（默认 100ms，范围 50-500）
- **PowerShell 回退**：koffi 加载失败时自动降级到 PowerShell 方案

### 优化
- Windows IME 切换从 PowerShell 子进程改为 koffi FFI 直接调用
- `WindowsIMEManager` 重构为使用 `IMESwitcher` 统一切换入口
- `queryMode()` 增加活跃管理器实例回退，修复 koffi 不可用时硬编码返回 `'en'` 的问题

### 已知问题
- 所有 Windows 相关代码（koffi FFI、IMM32、TSF）均未在 Windows 实机测试
- TSF compartment 读写依赖 PowerShell COM，性能较慢（~100ms）
- `ASTAnalyzer.ts` 存在预先的 `esModuleInterop` 类型错误（非本次引入）

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

[0.6.0-beta]: https://github.com/CI124/auto-ime/compare/v0.5.0...v0.6.0-beta
[0.5.0]: https://github.com/CI124/auto-ime/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CI124/auto-ime/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CI124/auto-ime/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CI124/auto-ime/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CI124/auto-ime/releases/tag/v0.1.0
