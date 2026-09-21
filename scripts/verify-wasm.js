/**
 * scripts/verify-wasm.js — 语言语法产物完整性门禁（零依赖）
 *
 * 为什么需要它：wasm 语言文件【不入库】（16MB 二进制，见 docs/adr/0002），
 * fresh clone 后只能靠 postinstall 联网下载。于是有两个必须被机器守住的假设：
 *   1. 每个清单文件都真的存在且哈希与清单一致（下载被截断 / 上游换产物 → 立刻失败，
 *      而不是等到扩展运行时才表现为"AST 判定静默失效"）；
 *   2. `src/analysis/ASTAnalyzer.ts` 里 LANGUAGE_PROFILES 引用的每个 wasmFile 都在清单内
 *      （新增语言时只改了 TS 表、忘了登记清单/下载源，是这条流水线最可能踩的坑，
 *      而它的症状是"该语言的注释永远不切中文" —— 极难归因）。
 *
 * 用法: node scripts/verify-wasm.js
 * 退出码: 0 = 全部就绪, 1 = 缺失 / 校验不匹配 / 清单未登记
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CHECKSUMS } = require('./wasm-manifest');

const ROOT = path.resolve(__dirname, '..');
const WASM_DIR = path.join(ROOT, 'wasm');
const ANALYZER = path.join(ROOT, 'src', 'analysis', 'ASTAnalyzer.ts');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const problems = [];

// 1) 清单内每个文件：存在 + 哈希一致
if (!fs.existsSync(WASM_DIR)) {
  problems.push(`wasm 目录不存在: ${WASM_DIR}（请运行 npm install 触发 scripts/download-wasm.js）`);
} else {
  for (const [name, expected] of Object.entries(CHECKSUMS)) {
    const file = path.join(WASM_DIR, name);
    if (!fs.existsSync(file)) {
      problems.push(`缺失 ${name}`);
      continue;
    }
    const actual = sha256(file);
    if (actual !== expected) {
      problems.push(`SHA-256 不匹配 ${name}\n     期望 ${expected}\n     实际 ${actual}`);
    }
  }
}

// 2) LANGUAGE_PROFILES 引用的 wasmFile 必须都在清单内
if (!fs.existsSync(ANALYZER)) {
  problems.push(`找不到 ${ANALYZER}，无法核对语言表与清单的一致性`);
} else {
  const src = fs.readFileSync(ANALYZER, 'utf-8');
  const referenced = new Set([...src.matchAll(/'(tree-sitter-[\w-]+\.wasm)'/g)].map((m) => m[1]));
  if (referenced.size === 0) problems.push('ASTAnalyzer.ts 中未匹配到任何 wasm 文件名（语言表结构变了，请同步本门禁）');
  for (const name of referenced) {
    if (!CHECKSUMS[name]) problems.push(`ASTAnalyzer.ts 引用了 ${name}，但 scripts/wasm-manifest.js 未登记（该语言永远不会被下载）`);
  }
  for (const name of Object.keys(CHECKSUMS)) {
    if (!referenced.has(name)) problems.push(`清单里有 ${name}，但 ASTAnalyzer.ts 已不再引用（死依赖，应同步清理）`);
  }
}

if (problems.length) {
  console.error(`[verify-wasm] FAIL (${problems.length} 项)\n  ` + problems.join('\n  '));
  process.exit(1);
}

console.log(`[verify-wasm] OK — ${Object.keys(CHECKSUMS).length} 个语言 wasm 齐备且与清单、ASTAnalyzer 语言表一致`);
