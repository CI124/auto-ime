/**
 * scripts/verify-repo.js — 仓库自检门禁（零依赖，必须在 `npm ci` 之前可跑）
 *
 * 治什么：本项目 .gitignore 是「白名单」模式（先 `*` 再逐项 `!` 放行）。这种模式
 * 的失败方式是【静默】的 —— 新增目录若忘记放行，文件会被 Git 忽略，本地一切正常、
 * clone 出来却缺胳膊少腿。v0.9.0 之后的一轮重构就真实踩过：
 *   - `.github/workflows/ci.yml` 被忽略 → 声称"已建立 CI"但云端从未跑过
 *   - `src/core/poller.ts` 未入库      → fresh clone 直接编译不过
 *   - `test/controller-test.js` 等未入库 → `npm test` 在 fresh clone 上必失败
 *
 * 规则本身就是这三条断言，不需要人工记忆。见 docs/adr/0001-gitignore-whitelist-and-repo-self-check.md
 *
 * 用法: node scripts/verify-repo.js
 * 退出码: 0 = 仓库自洽, 1 = 存在被忽略的必需文件
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function fail(lines) {
  console.error('[verify-repo] FAIL\n  ' + lines.join('\n  '));
  process.exit(1);
}

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' });
    return new Set(out.split('\n').filter(Boolean).map((f) => f.replace(/\\/g, '/')));
  } catch (e) {
    return fail([`无法执行 git ls-files（本门禁需在 Git 仓库内运行）: ${e.message}`]);
  }
}

function walk(dir, collect = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return collect; // 目录级缺失由下方各项断言分别报错
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, collect);
    else collect.push(rel);
  }
  return collect;
}

const tracked = trackedFiles();
const missing = [];

// 1) CI 定义必须在仓库里 —— 否则"有 CI"只是本地幻觉
const workflows = walk('.github');
if (workflows.length === 0) missing.push('.github/ 下没有任何文件（CI 定义缺失或被 .gitignore 白名单排除）');
for (const wf of workflows) {
  if (!tracked.has(wf)) missing.push(`CI 文件未入库（.gitignore 白名单漏放行？）: ${wf}`);
}

// 2) src 下所有源文件必须入库 —— 漏一个就是 fresh clone 编译失败
for (const src of walk('src')) {
  if (/\.[cm]?[jt]sx?$/.test(src) && !tracked.has(src)) {
    missing.push(`源文件未入库: ${src}`);
  }
}

// 3) package.json 的 test 脚本引用的每个测试文件必须存在【且】入库
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const testCmd = (pkg.scripts && pkg.scripts.test) || '';
const referenced = [...testCmd.matchAll(/node\s+([\w./\\-]+\.js)/g)].map((m) => m[1].replace(/\\/g, '/'));
if (referenced.length === 0) missing.push('package.json 未声明任何测试脚本（npm test 形同虚设）');
for (const rel of referenced) {
  if (!fs.existsSync(path.join(ROOT, rel))) missing.push(`测试脚本引用了不存在的文件: ${rel}`);
  else if (!tracked.has(rel)) missing.push(`测试脚本未入库: ${rel}`);
}

// 4) 架构决策记录必须入库 —— 决策不外传 = 下一轮 AI 只能靠猜
const adr = walk('docs/adr').filter((f) => f.endsWith('.md'));
if (adr.length === 0) missing.push('docs/adr/ 下没有任何 ADR（架构决策记录缺失）');
for (const f of adr) {
  if (!tracked.has(f)) missing.push(`ADR 未入库: ${f}`);
}

if (missing.length) fail(missing);

console.log(
  `[verify-repo] OK — ${tracked.size} 个文件已入库；CI 定义、src、` +
  `${referenced.length} 个测试脚本、${adr.length} 份 ADR 均可从 fresh clone 获得`
);
