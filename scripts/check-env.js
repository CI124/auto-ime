/**
 * scripts/check-env.js
 *
 * 本地 Linux 开发环境检测脚本。
 * 检查系统是否安装并运行了 Fcitx5 或 IBus，
 * 并测试命令行工具 / D-Bus 的连通性。
 *
 * 用法: node scripts/check-env.js
 * 退出码: 0 = 至少一个 IME 可用, 1 = 未检测到可用 IME
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 辅助函数 ──────────────────────────────────────────────

function run(cmd, args, timeout) {
  try {
    return {
      ok: true,
      stdout: execFileSync(cmd, args, {
        encoding: 'utf-8',
        timeout: timeout || 3000,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim(),
      stderr: '',
    };
  } catch (e) {
    return {
      ok: false,
      stdout: (e.stdout || '').toString().trim(),
      stderr: (e.stderr || '').toString().trim(),
      message: e.message || String(e),
    };
  }
}

function runBash(script, timeout) {
  return run('bash', ['-c', script], timeout);
}

function hasCommand(cmd) {
  return runBash(`command -v ${cmd} >/dev/null 2>&1 && echo found`).ok;
}

function section(title) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
}

function pass(msg) { console.log(`  [PASS] ${msg}`); }
function fail(msg) { console.log(`  [FAIL] ${msg}`); }
function info(msg) { console.log(`  [INFO] ${msg}`); }
function warn(msg) { console.log(`  [WARN] ${msg}`); }

// ── 平台检测 ──────────────────────────────────────────────

section('平台信息');
info(`platform  = ${process.platform}`);
info(`arch      = ${process.arch}`);
info(`homedir   = ${os.homedir()}`);
info(`PATH      = ${process.env.PATH || '(空)'}`);

if (process.platform !== 'linux') {
  warn(`当前平台为 ${process.platform}，此脚本仅检测 Linux 输入法环境。`);
  if (process.platform === 'win32') {
    info('Windows 环境请使用 koffi FFI 或 PowerShell 回退方案。');
  }
  process.exit(0);
}

// ── Fcitx5 检测 ──────────────────────────────────────────

section('Fcitx5 检测');
const fcitx5 = { available: false, daemon: false, profile: false, switcher: false };

if (hasCommand('fcitx5-remote')) {
  pass('fcitx5-remote 命令存在');
  fcitx5.available = true;

  // 检测 profile 文件
  const profilePath = path.join(os.homedir(), '.config', 'fcitx5', 'profile');
  if (fs.existsSync(profilePath)) {
    pass(`profile 文件存在: ${profilePath}`);
    fcitx5.profile = true;

    // 解析 profile 中的输入法列表
    try {
      const content = fs.readFileSync(profilePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const methods = [];
      let inItems = false;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('[')) {
          inItems = /^\[Groups\/0\/Items\/\d+\]$/.test(line);
          continue;
        }
        if (inItems && line.startsWith('Name=')) {
          methods.push(line.substring('Name='.length).trim());
        }
      }
      if (methods.length) {
        info(`已配置输入法: ${methods.join(', ')}`);
      } else {
        warn('profile 中未找到输入法配置');
      }
    } catch (e) {
      warn(`读取 profile 失败: ${e.message}`);
    }
  } else {
    warn(`profile 文件不存在: ${profilePath}`);
  }

  // 测试 daemon 连通性
  const remoteResult = run('fcitx5-remote', [], 2000);
  if (remoteResult.ok) {
    const code = parseInt(remoteResult.stdout, 10);
    // fcitx5-remote 返回值: 1=inactive(英文), 2=active(中文), 0=disconnected
    if (code === 1 || code === 2) {
      pass(`fcitx5 daemon 运行中 (状态码=${code}, ${code === 2 ? '中文' : '英文'})`);
      fcitx5.daemon = true;
    } else if (code === 0) {
      fail('fcitx5 daemon 未连接 (状态码=0)');
    } else {
      warn(`fcitx5-remote 返回未知状态码: ${code}`);
    }
  } else {
    fail(`fcitx5-remote 执行失败: ${remoteResult.stderr || remoteResult.message}`);
  }

  // 测试输入法切换命令
  const switchResult = runBash('fcitx5-remote -n', 2000);
  if (switchResult.ok && switchResult.stdout) {
    pass(`fcitx5-remote -n 返回当前输入法: ${switchResult.stdout}`);
    fcitx5.switcher = true;
  } else {
    fail('fcitx5-remote -n 执行失败 (输入法名称查询)');
  }
} else {
  fail('fcitx5-remote 命令不存在');
}

// ── IBus 检测 ─────────────────────────────────────────────

section('IBus 检测');
const ibus = { available: false, daemon: false, dbus: false };

if (hasCommand('ibus')) {
  pass('ibus 命令存在');
  ibus.available = true;

  // 测试 ibus daemon
  const ibusResult = runBash('ibus read-config 2>/dev/null || ibus address 2>/dev/null', 3000);
  if (ibusResult.ok && ibusResult.stdout) {
    pass(`IBus daemon 可达 (address: ${ibusResult.stdout})`);
    ibus.daemon = true;
  } else {
    // 备选检测: ibus engine
    const engineResult = run('ibus', ['engine'], 2000);
    if (engineResult.ok) {
      pass(`IBus daemon 运行中 (当前引擎: ${engineResult.stdout || '(无)'} )`);
      ibus.daemon = true;
    } else {
      fail('IBus daemon 未运行或不可达');
    }
  }

  // 测试 D-Bus 连通性
  const dbusResult = runBash(
    'dbus-send --session --print-reply --dest=org.freedesktop.IBus ' +
    '/org/freedesktop/IBus org.freedesktop.IBus.GetAddress 2>&1',
    3000
  );
  if (dbusResult.ok && dbusResult.stdout.includes('string')) {
    pass('D-Bus IBus 接口可达');
    ibus.dbus = true;
  } else {
    // 备选: 检查 ibus 进程是否注册到 D-Bus
    const dbusCheck = runBash(
      'dbus-send --session --print-reply --dest=org.freedesktop.DBus ' +
      '/org/freedesktop/DBus org.freedesktop.DBus.ListNames 2>&1 | grep -i ibus',
      3000
    );
    if (dbusCheck.ok && dbusCheck.stdout.includes('ibus')) {
      pass('D-Bus 上检测到 IBus 服务');
      ibus.dbus = true;
    } else {
      warn('D-Bus IBus 接口不可达（自适应轮询不依赖 D-Bus，此项仅作环境诊断）');
    }
  }

  // 列出可用引擎
  const listResult = run('ibus', ['list-engine'], 3000);
  if (listResult.ok && listResult.stdout) {
    const engines = listResult.stdout.split('\n').filter(Boolean);
    info(`可用引擎数量: ${engines.length}`);
    const chinese = engines.filter(e => /pinyin|rime|wubi|cangjie|zhuyin|shuangpin/i.test(e));
    const english = engines.filter(e => /xkb|us|eng/i.test(e));
    if (chinese.length) info(`中文引擎: ${chinese.slice(0, 5).join(', ')}${chinese.length > 5 ? '...' : ''}`);
    if (english.length) info(`英文引擎: ${english.slice(0, 5).join(', ')}${english.length > 5 ? '...' : ''}`);
  }
} else {
  fail('ibus 命令不存在');
}

// ── D-Bus 可用性 ──────────────────────────────────────────

section('D-Bus 环境');
if (process.env.DBUS_SESSION_BUS_ADDRESS) {
  pass(`DBUS_SESSION_BUS_ADDRESS = ${process.env.DBUS_SESSION_BUS_ADDRESS}`);
} else {
  warn('DBUS_SESSION_BUS_ADDRESS 未设置');
}

const dbusDaemon = runBash('dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1 && echo ok');
if (dbusDaemon.ok) {
  pass('D-Bus session daemon 可达');
} else {
  fail('D-Bus session daemon 不可达');
}

// ── 汇总 ──────────────────────────────────────────────────

section('检测结果汇总');

const results = [
  { name: 'Fcitx5', available: fcitx5.available, daemon: fcitx5.daemon, detail: fcitx5.profile ? 'profile OK' : '' },
  { name: 'IBus',   available: ibus.available,   daemon: ibus.daemon,   detail: ibus.dbus ? 'D-Bus OK' : '' },
];

for (const r of results) {
  if (!r.available) {
    info(`${r.name}: 未安装`);
  } else if (!r.daemon) {
    warn(`${r.name}: 已安装但守护进程未运行 ${r.detail ? `(${r.detail})` : ''}`);
  } else {
    pass(`${r.name}: 可用 ✓ ${r.detail ? `(${r.detail})` : ''}`);
  }
}

const anyAvailable = results.some(r => r.available && r.daemon);

console.log('');
if (anyAvailable) {
  const active = results.filter(r => r.available && r.daemon).map(r => r.name);
  pass(`Auto IME 开发环境就绪。可用 IME: ${active.join(', ')}`);
  process.exit(0);
} else {
  fail('未检测到可用的输入法框架。Auto IME 扩展将回退到 NullManager (无操作)。');
  console.log('');
  console.log('  安装建议:');
  if (!fcitx5.available) {
    console.log('    Ubuntu/Debian:  sudo apt install fcitx5 fcitx5-chinese-addons');
    console.log('    Arch Linux:     sudo pacman -S fcitx5-im fcitx5-chinese-addons');
  }
  if (!ibus.available) {
    console.log('    Ubuntu/Debian:  sudo apt install ibus ibus-libpinyin');
    console.log('    Arch Linux:     sudo pacman -S ibus ibus-libpinyin');
  }
  console.log('');
  process.exit(1);
}
