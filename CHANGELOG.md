# 更新日志

本项目所有重要变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
