# 贡献指南

感谢您对 Auto IME 项目的关注！本文档将帮助您了解如何参与项目开发。

## 开发环境搭建

### 前置要求

- Node.js >= 16
- VS Code
- Linux 系统（Fcitx5/Fcitx4/IBus）

### 搭建步骤

1. **克隆仓库**
   ```bash
   git clone https://github.com/your-username/auto-ime.git
   cd auto-ime
   ```

2. **安装依赖**
   ```bash
   npm install
   ```
   此命令会自动下载 Tree-sitter WASM 文件。

3. **启动开发**
   ```bash
   # 监听模式（自动编译）
   npm run watch
   ```

4. **调试**
   - 按 `F5` 启动调试
   - 自动创建沙盒环境，安装 VSCodeVim 扩展
   - 在沙盒窗口中测试功能

## 项目结构

```
auto-ime/
├── src/                    # 源代码
│   ├── extension.ts        # 扩展入口，事件监听和生命周期管理
│   ├── ASTAnalyzer.ts      # Tree-sitter AST 分析器
│   └── IMEManager.ts       # 输入法管理器（Fcitx5/Fcitx4/IBus）
├── scripts/                # 辅助脚本
│   ├── download-wasm.js    # postinstall: 下载 WASM 文件
│   └── prepare-sandbox.js  # F5 前置: 准备测试沙盒
├── wasm/                   # Tree-sitter WASM 语言文件
├── dist/                   # 编译输出目录
├── esbuild.js              # 构建脚本
├── package.json            # 项目配置
└── tsconfig.json           # TypeScript 配置
```

## 核心模块

### extension.ts

扩展入口文件，负责：
- 注册 ESC 命令劫持
- 监听光标移动和文档变化
- 管理状态栏
- 协调 ASTAnalyzer 和 IMEManager

### ASTAnalyzer.ts

Tree-sitter AST 分析器，负责：
- 初始化 Tree-sitter WASM
- 按需加载语言 WASM
- 解析代码并判断光标是否在注释/字符串中

### IMEManager.ts

输入法管理器，负责：
- 自动检测系统输入法框架
- 通过 shell 命令切换输入法
- 支持 Fcitx5、Fcitx4、IBus

## 开发规范

### 代码风格

- 使用 TypeScript 严格模式
- 遵循现有代码风格
- 添加必要的注释（特别是复杂的 AST 遍历逻辑）

### 提交规范

使用语义化提交信息：

```
feat: 添加新功能
fix: 修复 bug
docs: 更新文档
style: 代码格式调整
refactor: 重构代码
test: 添加测试
chore: 构建/工具变更
```

示例：
```
feat: 添加 Rust 语言支持
fix: 修复注释开头位置检测错误
docs: 更新 README 安装说明
```

### 分支策略

- `main`：稳定版本
- `develop`：开发分支
- `feature/*`：功能分支
- `fix/*`：修复分支

## 添加新语言支持

### 步骤

1. **下载 WASM 文件**
   ```bash
   # 从 tree-sitter-wasms 下载
   wget https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-<language>.wasm
   mv tree-sitter-<language>.wasm wasm/
   ```

2. **更新 ASTAnalyzer.ts**
   
   在 `WASM_FILE_MAPPING` 中添加映射：
   ```typescript
   'language-id': 'tree-sitter-language.wasm',
   ```

   在 `TARGET_NODE_TYPES` 中添加节点类型：
   ```typescript
   'language-id': ['comment', 'string_literal'],
   ```

3. **测试**
   - 创建测试文件验证注释和字符串检测
   - 确认 ESC 和状态栏功能正常

### 节点类型参考

不同语言的 Tree-sitter 节点类型可能不同。调试方法：

```javascript
// 在 Node.js 中测试
const Parser = require('web-tree-sitter');
const lang = await Parser.Language.load('wasm/tree-sitter-xxx.wasm');
parser.setLanguage(lang);
const tree = parser.parse('your code here');
console.log(tree.rootNode.toString());
```

## 测试

### 手动测试

1. 按 `F5` 启动调试
2. 在沙盒窗口中：
   - 按 `i` 进入 Insert 模式
   - 移动光标到注释/字符串
   - 观察状态栏变化
   - 按 `ESC` 测试强制切换

### 检查日志

查看 "Auto IME" 输出面板：
- `[AST]`：AST 解析日志
- `[IME]`：输入法切换日志
- `[Mode]`：模式切换日志

## 提交 Pull Request

1. Fork 本仓库
2. 创建功能分支
3. 提交更改
4. 推送分支
5. 创建 Pull Request

### PR 描述模板

```markdown
## 变更说明

简要描述本次变更的内容。

## 变更类型

- [ ] 新功能
- [ ] Bug 修复
- [ ] 文档更新
- [ ] 重构
- [ ] 其他

## 测试

描述如何测试本次变更。

## 相关 Issue

关联的 Issue 编号。
```

## 问题反馈

提交 Issue 时请包含：
- 操作系统和版本
- VS Code 版本
- 输入法框架和版本
- 扩展版本
- 复现步骤
- 错误日志（"Auto IME" 输出面板）

## 许可证

贡献代码将采用与项目相同的 MIT 许可证。
