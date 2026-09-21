/**
 * 下载 Tree-sitter 语言 WASM 文件（postinstall）。
 *
 * 安全加固（对应重构计划 V2）：
 *   1. 每个文件都按内置 SHA-256 清单校验；下载后校验失败即删除并报错，防止被篡改的产物进入构建。
 *   2. 只跟随同源 (https://unpkg.com) 的重定向，拒绝跳转到任意主机 / 非 https。
 *   3. 已存在的文件仍会校验（不匹配仅告警，避免误伤已在本地的正常副本）。
 *
 * 注意：WASM 【不随仓库提交】（16MB 二进制，见 docs/adr/0002-wasm-not-in-repo.md），
 *       因此本脚本是 fresh clone 后获取语言语法的唯一途径；CI 会紧随其后跑
 *       scripts/verify-wasm.js 做完整性门禁。清单本身在 scripts/wasm-manifest.js（两处共用）。
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BASE_HOST, BASE_URL, CHECKSUMS } = require('./wasm-manifest');

const WASM_DIR = path.join(__dirname, '..', 'wasm');
const MAX_REDIRECTS = 3;

const LANGUAGES = Object.keys(CHECKSUMS).map((f) => f.replace(/^tree-sitter-/, '').replace(/\.wasm$/, ''));

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function verify(file, filename) {
  const expected = CHECKSUMS[filename];
  if (!expected) return true; // 无清单条目则不阻断
  const actual = await sha256(file);
  return actual === expected;
}

// 仅允许同源 https 重定向
function safeRedirectUrl(location) {
  try {
    const u = new URL(location, BASE_URL);
    if (u.protocol !== 'https:' || u.host !== BASE_HOST) return null;
    return u.href;
  } catch {
    return null;
  }
}

function download(url, dest, redirectsLeft) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const { statusCode, headers } = response;
      if (statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308) {
        response.resume(); // 丢弃响应体，避免 socket 挂起
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
        const next = safeRedirectUrl(headers.location);
        if (!next) return reject(new Error(`Refusing unsafe redirect target for ${url}: ${headers.location}`));
        return download(next, dest, redirectsLeft - 1).then(resolve, reject);
      }
      if (statusCode !== 200) {
        response.resume();
        return reject(new Error(`Failed to download ${url}: HTTP ${statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => { fs.unlink(dest, () => reject(err)); });
      response.on('error', (err) => { fs.unlink(dest, () => reject(err)); });
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

async function main() {
  if (!fs.existsSync(WASM_DIR)) fs.mkdirSync(WASM_DIR, { recursive: true });
  console.log('Verifying / downloading tree-sitter wasm files...');

  let failed = 0;
  for (const lang of LANGUAGES) {
    const filename = `tree-sitter-${lang}.wasm`;
    const dest = path.join(WASM_DIR, filename);

    if (fs.existsSync(dest)) {
      if (await verify(dest, filename)) {
        console.log(`[OK] ${filename} present and verified.`);
      } else {
        console.warn(`[WARN] ${filename} exists but checksum mismatch (using as-is).`);
      }
      continue;
    }

    try {
      console.log(`[DOWNLOAD] fetching ${filename}...`);
      await download(`${BASE_URL}${filename}`, dest, MAX_REDIRECTS);
      if (!(await verify(dest, filename))) {
        fs.unlinkSync(dest);
        throw new Error(`checksum mismatch for ${filename}`);
      }
      console.log(`[SUCCESS] ${filename} downloaded and verified.`);
    } catch (err) {
      failed++;
      console.error(`[ERROR] Failed to download ${filename}: ${err.message}`);
    }
  }

  if (failed > 0) process.exit(1);
}

main();
