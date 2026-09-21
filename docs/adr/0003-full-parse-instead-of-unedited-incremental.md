# ADR 0003: AST 分析退回全量解析（取消 tree-sitter 增量复用）

- 状态：Accepted
- 日期：2026-09-21
- 相关：`src/analysis/ASTAnalyzer.ts`、`test/ast-analyzer-test.js` §6、
  `docs/adr/0004-file-granularity-gates.md`

## 背景

`isCursorInCommentOrString()` 此前用实例级 `lastTree` 做增量解析：
`parser.parse(text, this.lastTree)`，并在解析失败时降级全量。

用真实 `web-tree-sitter` + 本仓库 `dist/wasm` 探针实测，得到两条确定性结论：

| 假设 | 实测结果 |
|---|---|
| "增量解析失败会抛异常，从而走 catch 降级" | **不成立**。跨语法复用旧树不抛错，只得到 `root = ERROR` 的树 |
| "不传 `tree.edit()` 也能安全复用旧树" | **不成立**。在游标上方插入 3 行后，注释节点退化为 `"functio"@0:0`，而全文重解析的真值是 `"// head"@3:0` |

即：**每次打字/移动游标后的 AST 判定都可能建立在区间已失效的节点上**。而
`test/ast-analyzer-test.js` 用"每个用例新建一个 analyzer 实例"规避了这个问题，
并在注释里写下"真实运行只在当前活动文档上增量解析"这一**不成立**的前提 ——
`lastTree` 是实例级单槽，切换文件/语言时必然被跨文档复用。所以 22/22 全绿是假绿灯。

同一缺陷在上一轮重构里已被 `P1`（缓存文档文本）部分掩盖：文本是新的，树是旧的。

## 决策

**取消增量复用，每次全量解析**（`parser.parse(text)`），并：

1. 用两条**同实例**回归用例把缺陷锁死：
   - 游标上方插入行后，同一位置仍须判为 `comment`；
   - 同一实例先分析 TS 再分析 PY，结果须与全新实例一致。
   （修复前两者都返回 `match:false` → 测试红；修复后绿。）
2. 把测试里"规避缺陷"的注释改为"隔离用例状态"，并指明缺陷已在源码层修复，
   **不允许再用测试手段绕过生产缺陷**。
3. `tree.delete()` 移到扫描之后（`try/finally`）—— `query.matches()` 返回的
   `SyntaxNode` 仍持有该树内存，先删后扫是 use-after-free 形态。
4. 顺带修掉同源的第二类假阳性：块注释快路径在标记所在行引号不成对时不再断言
   "在注释中"，改交 AST（`const re = "/*";` 曾让后续代码行被判为注释而切中文）。

## 代价与收益

- 收益：判定正确性不再依赖"编辑器变更是否被如实告知 tree-sitter"；删除一个实例级
  跨文档可变状态（`lastTree`），`ASTAnalyzer` 的可推理性提高。
- 代价：每次分析全量解析。缓解：已有 10/30/60ms 尾随防抖 + `analysisGeneration`
  取消 + `(uri,version)` 文本缓存，实测 1500 行 TypeScript 连续分析用例仍通过。
- 明确接受的风险：超大单文件（>10k 行）时 AST 路径耗时上升。**复审触发**：若在真实
  VS Code 中观察到游标移动卡顿（日志 `→ comment` 与 `switch to` 间隔 >16ms 频发），
  则实施下方"后续"方案，而不是重新引入未经 `edit()` 的复用。

## 后续（本轮有意不做）

真增量的最小正确形态：按 `uri` 持有 `Tree`（而非单槽），并把
`onDidChangeTextDocument` 的 `contentChanges` 映射为 `tree.edit({startIndex,
oldEndIndex, newEndIndex, startPosition, oldEndPosition, newEndPosition, delta})`
后再 `parse`。这需要给 `IAnalyzer` 增加"文档变更通知"入口 —— 属于接口变更，
应与性能测量数据一起做，不混入正确性修复。

## 被否决的替代方案

- **只按 uri 分槽、仍不传 `edit()`**：仍会被同文档的编辑错位（探针第 2 条结论）。
- **保留源码、只改测试让它别复用**：即"为缺陷写测试来证明缺陷不存在"，属
  `测试治理` 反模式，且下次改动源码就会重新踩中。
