# 更新日志

本项目所有重要变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

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

[未发布]: https://github.com/your-username/auto-vim-ime/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-username/auto-vim-ime/releases/tag/v0.1.0
