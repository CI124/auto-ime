# 更新日志

本项目所有重要变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[0.4.0]: https://github.com/CI124/auto-vim-ime/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CI124/auto-vim-ime/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CI124/auto-vim-ime/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CI124/auto-vim-ime/releases/tag/v0.1.0
