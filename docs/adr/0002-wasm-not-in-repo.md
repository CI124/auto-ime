# ADR 0002: Tree-sitter 语言 wasm 不入库，改由校验下载 + CI 完整性门禁

- 状态：Accepted
- 日期：2026-09-21
- 相关：`scripts/wasm-manifest.js`、`scripts/download-wasm.js`、`scripts/verify-wasm.js`、
  `src/analysis/ASTAnalyzer.ts`、`docs/adr/0001-gitignore-whitelist-and-repo-self-check.md`

## 背景

`wasm/` 下有 13 个语言语法二进制，合计约 16MB。历史上有意的取舍记录在提交
`784b3fe chore: switch to whitelist-only push (exclude 16MB wasm binaries)`。

问题是**文档与代码互相矛盾**：`.github/workflows/ci.yml` 写"wasm 语言文件已随仓库提交"，
`scripts/download-wasm.js` 写"WASM 已随仓库提交，正常情况下本脚本全部走 [SKIP] 分支"，
而 `git ls-files wasm` 实际返回 **0 行**。这类"看似无害的过期注释"正是让后续
AI/人对项目现状理解失真、进而做出错误判断的典型来源。

## 决策

**维持不入库**，并把它变成一条被机器守住的、有据可查的例外：

1. 修正 `ci.yml` 与 `download-wasm.js` 的假前提，明确写"不入库 → postinstall 是 fresh
   clone 的唯一获取途径 → CI 必须跑完整性门禁"。
2. 抽出 `scripts/wasm-manifest.js` 作为**唯一**清单（文件名 → SHA-256 + 固定版本下载源），
   由 `download-wasm.js`（下载）与 `verify-wasm.js`（门禁）共用，避免两份哈希漂移。
3. 新增 `scripts/verify-wasm.js`，在 CI 的 `npm ci` 之后、`compile` 之前执行，断言：
   - 清单内每个文件存在且 SHA-256 一致；
   - `ASTAnalyzer.ts` 的 `LANGUAGE_PROFILES` 引用的每个 `tree-sitter-*.wasm` 都在清单内
     （**反向也断言**：清单里有但语言表已不引用的，判为死配置，必须同步清理）。
4. `.gitignore` 尾部把 `wasm/**` 标注为**有意排除**，与"忘记放行"区分开。

## 这样做的代价与收益

- 收益：仓库历史不被 16MB 二进制永久占用（Git 中二进制删除也不缩体积）；新增语言时
  漏登记清单会被 CI 立刻抓住（症状"该语言注释永不切中文"极难归因，现在前移成构建失败）。
- 代价：fresh clone 依赖 `unpkg.com` 可达；已有缓解 —— 固定版本 + 同源 https 重定向限制 +
  哈希不匹配即删除报错（不会把可疑产物留下次再用）。
- 折中项（未采纳）：在 Release 资产里挂 wasm 压缩包。**过期条件**：若 unpkg 出现无法接受
  的可用性问题，改用该方案而不是回头把二进制塞进 Git。

## 被否决的替代方案

- **wasm 入库**：一次性解决网络依赖，但 16MB 永久进入历史，且 `git clone` 对纯改代码的
  贡献者同样昂贵。
- **不入库、也不加门禁（维持现状）**：已被证明会产生"CI 注释与事实相反"的理解失真。

## 适用与失效条件

- 适用：只要 wasm 仍由 `LANGUAGE_PROFILES` 按语言动态加载，本门禁就必须存在。
- 复审触发：切换到自带语法的 tree-sitter npm 包（或改用 WASM 单文件多语言打包）时，
  清单与下载脚本整体作废。
