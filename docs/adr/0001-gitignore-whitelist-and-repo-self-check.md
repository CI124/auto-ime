# ADR 0001: `.gitignore` 白名单模式 + 仓库自检门禁

- 状态：Accepted
- 日期：2026-09-21
- 相关：`docs/adr/0002-wasm-not-in-repo.md`、`scripts/verify-repo.js`、`.github/workflows/ci.yml`

## 背景

`.gitignore` 采用「先 `*` 全忽略、再逐项 `!` 放行」的白名单模式（动机：仓库要排除
16MB wasm、`dist/`、本地测试环境与各类日志，逐项黑名单更易漏）。

白名单模式的失败方式是**静默**的：新增一个目录若忘记放行，它会被 Git 忽略，本地一切
正常，`clone` 出来却缺文件。v0.9.0 之后的一轮重构实际踩中三类后果：

| 被忽略的东西 | 后果 |
|---|---|
| `.github/workflows/ci.yml` | 重构计划里 T2「已建立 CI」被勾选，但云端从未跑过一次 —— 门禁只存在于本地 |
| `src/core/poller.ts` | fresh clone 直接 `tsc` 失败 |
| `test/controller-test.js`、`test/vim-mode-test.js` | `npm test` 在 fresh clone 上必失败 |

同时确认：`wasm/`、`REFACTOR_PLAN.md`、`auto-ime-*.vsix` 也都是被忽略状态。

## 决策

1. **保留白名单模式**（黑名单模式在这个仓库更易漏），但补上放行项：`.github/`、`docs/`。
2. **决策文档入库**：`REFACTOR_PLAN.md` → `docs/REFACTOR_PLAN.md`，并新增 `docs/adr/`。
3. **把"仓库自洽"变成一条机器断言**：新增零依赖脚本 `scripts/verify-repo.js`，在
   `npm ci` **之前**执行（不依赖 node_modules），断言四件事：
   - `.github/` 下所有文件已入库；
   - `src/**` 下所有 `.ts/.tsx/.js` 已入库；
   - `package.json` 的 `scripts.test` 引用的每个测试文件**存在且已入库**；
   - `docs/adr/` 下至少有一份 ADR 且全部已入库。
4. `.gitignore` 尾部显式记录**有意排除项及其理由**（区分"故意不入库"和"忘了放行"）。

## 这样做的代价与收益

- 收益：漏放行会在 CI 第一步就红，而不是在别人的 fresh clone 上表现为"编译不过"。
- 代价：新增源码目录时需要同时考虑 `.gitignore` 与本门禁（本门禁会自动把它抓出来）。

## 被否决的替代方案

- **改用黑名单式 `.gitignore`**：会把 wasm/`dist`/本地环境/日志重新变成"靠人记着排除"，
  回归风险更高。
- **只在 CONTRIBUTING 里写"记得检查 git status"**：属于"写进文档但工具不检查的规则"，
  等于没有。

## 适用与失效条件

- 适用：只要仓库继续用白名单模式，本门禁就必须存在。
- 复审触发：若某天改回黑名单模式，`verify-repo.js` 的第 1、2 项断言失去意义，但第 3 项
  （测试脚本必须入库）与第 4 项（ADR 必须入库）仍然成立 —— 保留脚本，收窄断言。
