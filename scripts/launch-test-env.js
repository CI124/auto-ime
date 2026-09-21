'use strict';

/**
 * 一键搭建隔离的 VS Code 手动测试环境。
 *
 * 做的事情：
 *   1. 用 esbuild 从当前源码编译 dist/extension.js
 *   2. 用 @vscode/vsce 重新打包出最新的 auto-ime vsix
 *   3. 用 @vscode/test-electron 下载便携版 VS Code（不碰本机已装环境）
 *   4. 在完全独立的 extensions / user-data 目录里，只安装
 *      auto-ime(新 vsix) 和 vscodevim.vim 两个插件
 *   5. 生成隔离工作区与手动测试用例，然后弹出一个干净的 VS Code 窗口
 *
 * 用法：
 *   node scripts/launch-test-env.js            # 完整流程（每次重新打包+重装）
 *   node scripts/launch-test-env.js --skip-build   # 复用已有 vsix，只刷新窗口
 *   node scripts/launch-test-env.js --reuse        # 跳过插件重装（更快）
 *   node scripts/launch-test-env.js --refresh-vim  # 强制重新联网安装 vim
 *
 * 说明：vim 首次下载后会跨运行保留在隔离目录，之后的重跑不再联网下载，
 *       只重刷会变化的 auto-ime，因此对扩展市场的网络抖动更具鲁棒性。
 *
 * 离线安装 vim（市场 CDN 不可达时）：把一个 vim 的 .vsix 放到
 *   .vscode-test-env/ext-cache/ （文件名含 vim 即可），或设置环境变量
 *   AUTO_IME_VIM_VSIX=<vsix 路径>；脚本会优先用本地 vsix 而非联网下载。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { createVSIX } = require('@vscode/vsce');
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} = require('@vscode/test-electron');

const ROOT = path.resolve(__dirname, '..');
const ENV_DIR = path.join(ROOT, '.vscode-test-env');
const EXT_DIR = path.join(ENV_DIR, 'extensions');
const USER_DATA_DIR = path.join(ENV_DIR, 'user-data');
const VSCODE_CACHE_DIR = path.join(ENV_DIR, 'vscode');
const VSIX_DIR = path.join(ENV_DIR, 'vsix');
const EXT_CACHE_DIR = path.join(ENV_DIR, 'ext-cache');
const WORKSPACE_DIR = path.join(ENV_DIR, 'workspace');

const VIM_EXT_ID = 'vscodevim.vim';
const VS_CODE_VERSION = 'stable';
const PID_FILE = path.join(ENV_DIR, 'launched-pids.json');

const argv = process.argv.slice(2);
const SKIP_BUILD = argv.includes('--skip-build');
const REUSE_INSTALL = argv.includes('--reuse');
const FORCE_VIM = argv.includes('--refresh-vim');

function log(msg) {
  console.log(`\x1b[36m[test-env]\x1b[0m ${msg}`);
}
function fail(msg) {
  console.error(`\x1b[31m[test-env] ERROR:\x1b[0m ${msg}`);
  process.exit(1);
}

function ensureDirs() {
  for (const dir of [
    ENV_DIR,
    EXT_DIR,
    USER_DATA_DIR,
    VSCODE_CACHE_DIR,
    VSIX_DIR,
    EXT_CACHE_DIR,
    WORKSPACE_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 1) 编译 bundle，保证 vsix 反映最新源码 */
function compile() {
  log('编译 dist/extension.js ...');
  const res = spawnSync(process.execPath, ['esbuild.js'], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) {
    fail('esbuild 编译失败，请先运行 npm run compile 排查');
  }
}

/** 2) 用 vsce 重新打包，返回生成的 vsix 路径 */
async function buildVsix() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const vsixPath = path.join(VSIX_DIR, `${pkg.name}-${pkg.version}.vsix`);

  log(`重新打包扩展 ${pkg.name}@${pkg.version} ...`);
  await createVSIX({
    cwd: ROOT,
    packagePath: VSIX_DIR,
    useYarn: false,
    // 该仓库已随包提交 wasm / node_modules 白名单，允许缺省项通过
    allowMissingRepository: true,
    allowStarActivation: true,
  });

  if (!fs.existsSync(vsixPath)) {
    fail(`未找到打包产物 ${vsixPath}`);
  }
  const size = (fs.statSync(vsixPath).size / 1024 / 1024).toFixed(2);
  log(`打包完成: ${path.relative(ROOT, vsixPath)} (${size} MB)`);
  return vsixPath;
}

/** 3) 下载便携版 VS Code，返回可执行文件路径 */
async function resolveVSCode() {
  log(`下载/复用便携版 VS Code (${VS_CODE_VERSION}) ...`);
  return downloadAndUnzipVSCode({
    version: VS_CODE_VERSION,
    cachePath: VSCODE_CACHE_DIR,
  });
}

/** 取出 CLI 可执行文件与“去掉默认 profile 目录”后的初始参数，避免与自定义目录重复 */
function splitCliArgs(cliArgs) {
  const [cli, ...rest] = cliArgs;
  const stripped = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    // 同时处理 --key=value 和 --key value 两种形式，剔除 CLI 预置的默认 profile 目录
    if (/^--(extensions-dir|user-data-dir)(=|$)/.test(arg)) {
      if (!arg.includes('=')) i++; // 空格形式时跳过下一个值
      continue;
    }
    stripped.push(arg);
  }
  return { cli, initArgs: stripped };
}

/** 用便携版 VS Code 的 CLI 安装扩展（写入隔离的 extensions 目录）
 *  spec 可为单个字符串或字符串数组；多个扩展合并到一次 code 调用，避免多次调用之间的实例冲突 */
function installExtension(cliArgs, spec, opts = {}) {
  const { force = true } = opts;
  const list = Array.isArray(spec) ? spec : [spec];
  const { cli, initArgs } = splitCliArgs(cliArgs);
  const args = [
    ...initArgs,
    '--extensions-dir', EXT_DIR,
    '--user-data-dir', USER_DATA_DIR,
  ];
  for (const s of list) args.push('--install-extension', s);
  if (force) args.push('--force');
  log(`安装扩展: ${list.join(' , ')}`);
  const res = spawnSync(cli, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (out) console.log(out.split('\n').map((l) => `    ${l}`).join('\n'));
  return { ok: res.status === 0, output: out };
}

/** 查找可离线安装的 vim vsix（环境变量优先，其次 ext-cache 目录） */
function findCachedVimVsix() {
  if (process.env.AUTO_IME_VIM_VSIX && fs.existsSync(process.env.AUTO_IME_VIM_VSIX)) {
    return process.env.AUTO_IME_VIM_VSIX;
  }
  if (fs.existsSync(EXT_CACHE_DIR)) {
    const hit = fs
      .readdirSync(EXT_CACHE_DIR)
      .filter((f) => /\.vsix$/i.test(f) && /vim/i.test(f))
      .map((f) => path.join(EXT_CACHE_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (hit.length) return hit[0];
  }
  return null;
}

/** 从 <extensions-dir>/extensions.json 清单里按 id 前缀剔除登记项
 *  （否则 VS Code 会因残留登记而判定扩展“已装且运行”，报 “restart before reinstalling”） */
function purgeFromManifest(prefixLower) {
  const manifest = path.join(EXT_DIR, 'extensions.json');
  if (!fs.existsSync(manifest)) return;
  try {
    const list = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!Array.isArray(list)) return;
    const filtered = list.filter(
      (e) => !((e && e.identifier && e.identifier.id) || '').toLowerCase().startsWith(prefixLower)
    );
    if (filtered.length !== list.length) {
      fs.writeFileSync(manifest, JSON.stringify(filtered), 'utf8');
      log(`已从 extensions.json 清除 ${prefixLower} 的残留登记`);
    }
  } catch (e) {
    /* 清单损坏时忽略，VS Code 会重建 */
  }
}

/** 4) 只安装 auto-ime(新 vsix) 与 vim 两个插件到隔离目录 */
function installExtensions(cliArgs, vsixPath) {
  const SELF_ID = 'ci124.auto-ime'; // publisher.name
  const VIM_PREFIX = VIM_EXT_ID; // 'vscodevim.vim'
  const lower = (s) => s.toLowerCase();
  const hasExt = (prefix) =>
    fs.existsSync(EXT_DIR) && fs.readdirSync(EXT_DIR).some((e) => lower(e).startsWith(prefix));

  // 清理旧扩展：删除除 vim 以外的一切（vim 跨运行复用，避免重复联网下载）。
  // 若测试窗口开着会锁住文件，记录被锁项。
  const locked = new Set();
  if (!REUSE_INSTALL && fs.existsSync(EXT_DIR)) {
    for (const entry of fs.readdirSync(EXT_DIR)) {
      if (lower(entry).startsWith(VIM_PREFIX) && !FORCE_VIM) continue;
      const full = path.join(EXT_DIR, entry);
      try {
        if (fs.statSync(full).isDirectory()) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch (err) {
        locked.add(lower(entry));
        log(`旧扩展 ${entry} 被占用，无法清理（可能有测试窗口未关闭）`);
      }
    }
  }

  // 收集需一次性安装的 spec：vim（可能联网）与 auto-ime（本地 vsix）
  const specs = [];
  let vimNeedsNetwork = false;
  const selfLocked = [...locked].some((e) => e.startsWith(SELF_ID));

  if (hasExt(VIM_PREFIX) && !FORCE_VIM) {
    log(`${VIM_EXT_ID} 已存在，跳过下载（--refresh-vim 可强制重装）`);
  } else {
    const cachedVim = findCachedVimVsix();
    if (cachedVim) {
      log(`从本地缓存离线安装 vim: ${path.relative(ROOT, cachedVim)}`);
      specs.push(cachedVim);
    } else {
      specs.push(VIM_EXT_ID);
      vimNeedsNetwork = true;
    }
  }

  if (vsixPath) {
    if (selfLocked) {
      log('⚠ 检测到有测试窗口正在使用 Auto IME，无法更新到最新 vsix；请关闭窗口后重跑。');
    } else {
      // 关键：先删除 auto-ime 在 extensions.json 里的残留登记，否则会被判为“重装运行中扩展”而失败
      purgeFromManifest(SELF_ID);
      specs.push(vsixPath);
    }
  }

  // 单次 code 调用安装全部（--force），必要时对网络瞬断/实例冲突做退避重试
  if (specs.length) {
    const maxAttempts = vimNeedsNetwork ? 4 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const r = installExtension(cliArgs, specs, { force: true });
      if (r.ok) break;
      const retryable = /ECONNRESET|aborted|ETIMEDOUT|EAI_AGAIN|network|unable to get|restart|in use/i.test(
        r.output || ''
      );
      if (attempt < maxAttempts && retryable) {
        sleepSync(2000 * attempt);
        continue;
      }
      break;
    }
  }

  // 以磁盘真实状态为准做最终校验，避免被 CLI 退出码/残留实例误导
  if (!hasExt(VIM_PREFIX)) {
    fail(
      `vim (${VIM_EXT_ID}) 未安装成功（可能是市场网络问题）。可稍后重试，或将 vim 的 .vsix 放入 ext-cache / 设 AUTO_IME_VIM_VSIX 走离线安装。`
    );
  }
  if (vsixPath && !selfLocked && !hasExt(SELF_ID)) {
    fail(
      `auto-ime vsix 未能装入隔离目录（可能有残留实例占用 user-data）。请关闭所有测试窗口后重试。`
    );
  }
}

/** 5) 生成隔离工作区与手动测试用例（仅在文件不存在时创建，保留用户改动） */
function seedWorkspace() {
  const writeIfMissing = (rel, content) => {
    const full = path.join(WORKSPACE_DIR, rel);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
  };

  writeIfMissing(
    '.vscode/settings.json',
    JSON.stringify(
      {
        'vim.useCtrlKeys': true,
        'vim.enableNeovim': false,
        'editor.lineNumbers': 'on',
        'auto-ime.windows.strategy': 'auto',
      },
      null,
      2
    ) + '\n'
  );

  writeIfMissing(
    'demo.js',
    [
      '// 在插入模式(i)下输入中文注释，按 Esc 应切回英文输入法',
      'function add(a, b) {',
      "  // 这里尝试输入中文：你好，世界",
      "  const greeting = '你好';",
      '  return a + b;',
      '}',
      '',
      '// 光标停在字符串/注释里输入中文，停在代码区按 Esc 回英文',
      'export default add;',
      '',
    ].join('\n')
  );

  writeIfMissing(
    'notes.txt',
    [
      '纯文本输入区：',
      '1) 按 i 进入插入模式，用中文随便打几个字',
      '2) 按 Esc，观察输入法是否自动切回英文',
      '3) 按 Ctrl+Shift+Space，测试中英文手动切换',
      '',
    ].join('\n')
  );

  writeIfMissing(
    'MANUAL-TEST-CASES.md',
    [
      '# Auto IME 手动测试用例',
      '',
      '本窗口是**完全隔离**的测试环境：只安装了 `Auto IME`(本地最新打包) 和 `VSCodeVim` 两个插件。',
      '',
      '## 前置条件',
      '- Windows 已安装中文输入法（微软拼音或任意 IME）',
      '- 若用双键盘策略：确保同时装有 English(United States) 键盘布局',
      '',
      '## 用例 1：Vim Esc 自动切英文',
      '1. 打开 `demo.js`，按 `i` 进入插入模式',
      '2. 切换到中文输入法，输入「你好」',
      '3. 按 `Esc` → 预期：退出插入模式，且输入法自动切回英文',
      '',
      '## 用例 1b：进入 Normal(n) 模式自动切英文（不限 Esc）',
      '> 验证点：只要从插入模式回到普通模式（光标由竖线变方块），就会强制切英文。',
      '1. `i` 进入插入模式并切到中文输入法',
      '2. 用 `Esc` 以外的方式回普通模式（如被插件映射的退出键），观察状态栏',
      '3. 预期：进入 n 模式瞬间输入法切回英文（状态栏显示 `EN`）',
      '4. 反向验证：在注释行按 `i` 重新进入插入模式 → 应自动切回中文（`中`）',
      '',
      '## 用例 2：手动切换中英文',
      '1. 焦点在编辑器内',
      '2. 按 `Ctrl+Shift+Space` → 预期：中英文输入法互相切换',
      '',
      '## 用例 3：纯文本区行为',
      '1. 打开 `notes.txt`，`i` 进入插入模式输入中文',
      '2. 按 `Esc` → 预期：切回英文',
      '',
      '## 策略切换验证',
      '- 打开设置搜索 `auto-ime.windows.strategy`，在 `auto` / `dual-keyboard` / `single-keyboard` 间切换后 Reload Window，重复用例 1',
      '',
      '> 若需查看插件日志：命令面板运行 `Developer: Show Logs...` → 选择对应窗口日志目录，',
      '> 或在输出面板(Output)选择 Auto IME 相关通道。',
      '',
    ].join('\n')
  );

  log(`隔离工作区: ${path.relative(ROOT, WORKSPACE_DIR)}`);
}

/** 6) 弹出干净的 VS Code 窗口，并记录 PID 以便下次运行时关闭 */
function launchWindow(executablePath) {
  const args = [
    '--extensions-dir', EXT_DIR,
    '--user-data-dir', USER_DATA_DIR,
    '--new-window',
    '--disable-workspace-trust',
    WORKSPACE_DIR,
  ];
  log('启动 VS Code 测试窗口 ...');
  const child = spawn(executablePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // 记录已启动窗口的 PID 列表（累加），供下次 closeTestInstances 回收
  let pids = [];
  try {
    pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (!Array.isArray(pids)) pids = [];
  } catch (e) {
    pids = [];
  }
  if (child.pid) pids.push(child.pid);
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify(pids), 'utf8');
  } catch (e) {
    /* 写入失败不影响主流程 */
  }
}

/** 同步 sleep，等待 OS 释放文件句柄 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * 关闭由本脚本之前启动的 VS Code 测试实例（根据记录的 PID 杀进程树）。
 * 避免旧窗口占用扩展目录导致“Please restart before reinstalling”。
 * 不依赖本机其它编辑器，仅针对自己启动的进程。
 */
function closeTestInstances() {
  if (REUSE_INSTALL) return;
  let pids = [];
  try {
    pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (!Array.isArray(pids)) pids = [];
  } catch (e) {
    pids = [];
  }
  if (!pids.length) return;

  log(`关闭 ${pids.length} 个残留的测试窗口 ...`);
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        // /T 连同子进程一起结束
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        // 我们自己是以 detached 启动，子进程为新进程组领导者，kill(-pid) 可杀整组
        process.kill(-pid, 'SIGKILL');
      }
    } catch (e) {
      /* 进程可能已退出，忽略 */
    }
  }
  try {
    fs.writeFileSync(PID_FILE, '[]', 'utf8');
  } catch (e) {
    /* ignore */
  }
  sleepSync(1500);
}

async function main() {
  ensureDirs();
  closeTestInstances();

  let vsixPath = null;
  if (!SKIP_BUILD) {
    compile();
    vsixPath = await buildVsix();
  } else {
    log('跳过编译/打包 (--skip-build)');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const candidate = path.join(VSIX_DIR, `${pkg.name}-${pkg.version}.vsix`);
    if (fs.existsSync(candidate)) vsixPath = candidate;
  }

  const executablePath = await resolveVSCode();
  const cliArgs = resolveCliArgsFromVSCodeExecutablePath(executablePath);

  installExtensions(cliArgs, vsixPath);
  seedWorkspace();
  launchWindow(executablePath);

  log('完成 ✅  干净的测试窗口已弹出（只含 Auto IME + Vim）。');
  log('测试步骤见工作区内的 MANUAL-TEST-CASES.md');
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
