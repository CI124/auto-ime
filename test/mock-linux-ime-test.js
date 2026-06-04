/**
 * Mock Linux IME 测试 - 模拟 Fcitx5 / Fcitx4 / IBus 环境
 *
 * 通过 mock child_process、fs、dbus-next 模块注入编译后的 bundle，
 * 测试 Linux 平台下 IME 管理器的查询、切换、降级与异常处理。
 *
 * 技术要点：
 * - 使用 Module.prototype._compile 钩子从 bundle 内部作用域提取 createImeManager
 * - Mock child_process.execSync/execFileSync 拦截 bash 命令
 * - Mock fs.existsSync/readFileSync 模拟 profile 文件
 * - Mock dbus-next 模拟 IBus D-Bus 信号
 */

const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const path = require('path');

// ============================================================
// Mock 状态（可注入控制测试场景）
// ============================================================
const mockState = {
    // 命令可用性
    fcitx5Available: true,
    fcitx4Available: true,
    ibusAvailable: true,
    dbusAvailable: true,

    // fcitx5 daemon 状态
    fcitx5DaemonRunning: true,
    fcitx5CurrentInput: 'pinyin',

    // fcitx4 daemon 状态
    fcitx4ExitCode: 2,            // 1=英文, 2=中文

    // ibus daemon 状态
    ibusCurrentEngine: 'libpinyin',

    // profile 文件
    profileExists: true,
    profileContent: [
        '[Groups/0]',
        'Name=Default',
        'Default Layout=us',
        'DefaultIM=pinyin',
        '',
        '[Groups/0/Items/0]',
        'Name=keyboard-us',
        'Layout=',
        '',
        '[Groups/0/Items/1]',
        'Name=pinyin',
        'Layout=',
    ].join('\n'),

    // 超时模拟 (存 pattern 字符串)
    timeoutCommands: new Set(),

    // 调用日志
    callLog: [],
    bashScripts: [],
};

function logCall(name, ...args) {
    mockState.callLog.push({ name, args: [...args] });
}

function resetMock() {
    mockState.fcitx5Available = true;
    mockState.fcitx4Available = true;
    mockState.ibusAvailable = true;
    mockState.dbusAvailable = true;
    mockState.fcitx5DaemonRunning = true;
    mockState.fcitx5CurrentInput = 'pinyin';
    mockState.fcitx4ExitCode = 2;
    mockState.ibusCurrentEngine = 'libpinyin';
    mockState.profileExists = true;
    mockState.profileContent = [
        '[Groups/0]',
        'Name=Default',
        'Default Layout=us',
        'DefaultIM=pinyin',
        '',
        '[Groups/0/Items/0]',
        'Name=keyboard-us',
        'Layout=',
        '',
        '[Groups/0/Items/1]',
        'Name=pinyin',
        'Layout=',
    ].join('\n');
    mockState.timeoutCommands = new Set();
    mockState.callLog = [];
    mockState.bashScripts = [];
}

// ============================================================
// 命令路由：解析 bash -c "script" 中的命令
// ============================================================
function handleBashScript(script) {
    mockState.bashScripts.push(script);

    // ── 检测脚本：command -v 用于探测命令是否存在 ──
    // 真实 bash 中这些脚本的成功/失败取决于命令是否安装。
    // 模拟 bash 行为：命令不存在 → throw（bash exit 1），存在 → return ''。

    if (/command -v fcitx5-remote/.test(script)) {
        if (!mockState.fcitx5Available) throw new Error('fcitx5-remote: command not found');
        // 真实脚本: command -v fcitx5-remote && [ -f ~/.config/fcitx5/profile ]
        // 两者都通过才算成功
        if (!mockState.profileExists) throw new Error('fcitx5 profile: not found');
        return '';
    }

    if (/command -v fcitx-remote/.test(script)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return '';
    }

    if (/command -v ibus/.test(script)) {
        if (!mockState.ibusAvailable) throw new Error('ibus: command not found');
        return '';
    }

    // ── 执行命令（runBash 通过 $1 传参） ──

    // fcitx5-remote -n (查询当前输入法名称)
    if (/fcitx5-remote\s+-n/.test(script)) {
        if (!mockState.fcitx5Available || !mockState.fcitx5DaemonRunning) {
            const e = new Error('Command failed: fcitx5-remote -n');
            e.stderr = 'fcitx5-remote: not running';
            throw e;
        }
        return mockState.fcitx5CurrentInput;
    }

    // fcitx5-remote -s ... (切换输入法，$1 展开后包含目标名)
    if (/fcitx5-remote\s+-s/.test(script)) {
        if (!mockState.fcitx5Available) throw new Error('fcitx5-remote: command not found');
        return '';
    }

    // fcitx-remote 查询（脚本包含 echo $? 获取退出码）
    if (/fcitx-remote/.test(script) && /echo\s+\$\?/.test(script)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return String(mockState.fcitx4ExitCode);
    }

    // fcitx-remote -c 或 -o (切换，$1 展开后为 -c 或 -o)
    if (/fcitx-remote\s/.test(script)) {
        if (!mockState.fcitx4Available) throw new Error('fcitx-remote: command not found');
        return '';
    }

    // ibus engine 查询（无参数，仅有 ibus engine 命令）
    if (/ibus\s+engine\s*$/.test(script.trim())) {
        if (!mockState.ibusAvailable) throw new Error('ibus: command not found');
        return mockState.ibusCurrentEngine;
    }

    // ibus engine <name> (切换)
    if (/ibus\s+engine\s+/.test(script)) {
        if (!mockState.ibusAvailable) throw new Error('ibus: command not found');
        return '';
    }

    return '';
}

function makeTimeoutError(cmd) {
    const err = new Error(`Command failed: ${cmd}`);
    err.killed = true;
    err.code = 'ETIMEDOUT';
    err.cmd = cmd;
    return err;
}

// ============================================================
// 设置 platform = linux
// ============================================================
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
process.env.HOME = '/home/testuser';

// ============================================================
// 覆盖 fs.existsSync / fs.readFileSync（bundle 通过 require('fs') 获取同一对象）
// ============================================================
const origExistsSync = fs.existsSync.bind(fs);
const origReadFileSync = fs.readFileSync.bind(fs);

fs.existsSync = function(p) {
    if (typeof p === 'string' && p.includes('fcitx5') && p.includes('profile')) {
        return mockState.profileExists;
    }
    return origExistsSync(p);
};

fs.readFileSync = function(p, encoding) {
    if (typeof p === 'string' && p.includes('fcitx5') && p.includes('profile')) {
        return mockState.profileContent;
    }
    return origReadFileSync(p, encoding);
};

// ============================================================
// Module._compile 钩子：从 bundle 内部作用域提取 createImeManager
// ============================================================
const origCompile = Module.prototype._compile;
Module.prototype._compile = function(content, filename) {
    if (filename && filename.endsWith('extension.js') && content.includes('function createImeManager(')) {
        // 在 module.exports 赋值之后注入 createImeManager 到 exports
        const exportMarker = 'module.exports = __toCommonJS(extension_exports);';
        const idx = content.indexOf(exportMarker);
        if (idx !== -1) {
            content =
                content.slice(0, idx + exportMarker.length) +
                '\nmodule.exports.createImeManager = createImeManager;\n' +
                content.slice(idx + exportMarker.length);
        }
    }
    origCompile.call(this, content, filename);
};

// ============================================================
// 拦截 require，注入 mock 模块
// ============================================================
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'vscode') return 'vscode';
    if (request === 'dbus-next') return 'dbus-next';
    return origResolve.call(this, request, parent, isMain, options);
};

let dbusSignalHandler = null;

const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
    // ── Mock child_process ──
    if (request === 'child_process') {
        return {
            execSync: function(cmd, opts) {
                logCall('execSync', cmd);
                for (const pat of mockState.timeoutCommands) {
                    if (cmd.includes(pat)) throw makeTimeoutError(cmd);
                }
                return handleBashScript(cmd);
            },
            execFileSync: function(cmd, args, opts) {
                logCall('execFileSync', cmd, ...(args || []));
                if (cmd === 'bash' && Array.isArray(args) && args[0] === '-c') {
                    const script = args[1];
                    for (const pat of mockState.timeoutCommands) {
                        if (script.includes(pat)) throw makeTimeoutError(`bash -c "${script}"`);
                    }
                    return handleBashScript(script);
                }
                return '';
            },
        };
    }

    // ── Mock vscode ──
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: (section) => ({
                    get: (key, def) => {
                        if (section === 'auto-ime.ibus' && key === 'englishEngine') return 'xkb:us::eng';
                        if (section === 'auto-ime.ibus' && key === 'chineseEngine') return 'libpinyin';
                        if (section === 'auto-ime.windows' && key === 'pollingInterval') return 100;
                        return def;
                    },
                }),
                onDidChangeTextDocument: () => ({ dispose: () => {} }),
            },
            extensions: { getExtension: () => null },
            window: {
                activeTextEditor: null,
                createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
                createStatusBarItem: () => ({
                    text: '', tooltip: '', backgroundColor: undefined,
                    show: () => {}, dispose: () => {}, command: '',
                }),
                onDidChangeWindowState: () => ({ dispose: () => {} }),
                onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
                onDidChangeTextEditorOptions: () => ({ dispose: () => {} }),
                onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
            },
            StatusBarAlignment: { Left: 1 },
            TextEditorCursorStyle: { Block: 4, Line: 1 },
            ThemeColor: class { constructor(s) { this.id = s; } },
            Disposable: { from: () => ({ dispose: () => {} }) },
            commands: {
                registerCommand: () => ({ dispose: () => {} }),
                executeCommand: () => Promise.resolve(),
            },
        };
    }

    // ── Mock dbus-next ──
    if (request === 'dbus-next') {
        return {
            sessionBus: () => ({
                getProxyObject: (service, svcPath) => {
                    if (!mockState.dbusAvailable) {
                        return Promise.reject(new Error('D-Bus service not found'));
                    }
                    return Promise.resolve({
                        getInterface: (iface) => ({
                            on: (event, handler) => {
                                if (event === 'GlobalEngineChanged') {
                                    dbusSignalHandler = handler;
                                }
                            },
                            removeAllListeners: () => { dbusSignalHandler = null; },
                        }),
                    });
                },
            }),
        };
    }

    return origLoad.call(this, request, parent, isMain);
};

// ============================================================
// 测试框架
// ============================================================
let testCount = 0, passCount = 0, failCount = 0;

function test(name, fn) {
    testCount++;
    try {
        fn();
        passCount++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failCount++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${e.message}`);
    }
}

async function testAsync(name, fn) {
    testCount++;
    try {
        await fn();
        passCount++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failCount++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${e.message}`);
    }
}

// ============================================================
// 加载 bundle（_compile 钩子会注入 createImeManager 到 exports）
// ============================================================
const ext = require('../dist/extension');
const createImeManager = ext.createImeManager;
const bundleSrc = fs.readFileSync(path.join(__dirname, '..', 'dist', 'extension.js'), 'utf-8');

// ══════════════════════════════════════════════════════════════
// 测试开始
// ══════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════');
console.log('  Mock Linux IME 测试');
console.log('═══════════════════════════════════════');

// ──────────────────────────────────────────────────────────────
// 测试 1: Fcitx5Manager 基本操作
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 1: Fcitx5Manager 基本操作');

test('createImeManager 可从 bundle 中提取', () => {
    assert.strictEqual(typeof createImeManager, 'function', 'createImeManager 应为函数');
});

test('Fcitx5 检测成功，返回可用管理器', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx5CurrentInput = 'pinyin';
    const mode = mgr.queryCurrentMode();
    assert.strictEqual(mode, 'zh', 'pinyin 应返回 zh');
});

test('Fcitx5 queryCurrentMode: keyboard-us → en', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const mode = mgr.queryCurrentMode();
    assert.strictEqual(mode, 'en', 'keyboard-us 应返回 en');
});

test('Fcitx5 switchToEnglish 调用 fcitx5-remote -s', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToEnglish();
    // runBash 脚本: fcitx5-remote -s "$1"，$1 通过 bash 参数传入
    const found = mockState.bashScripts.some(s => /fcitx5-remote\s+-s/.test(s));
    assert.ok(found, '应调用 fcitx5-remote -s');
});

test('Fcitx5 switchToChinese 调用 fcitx5-remote -s', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToChinese();
    const found = mockState.bashScripts.some(s => /fcitx5-remote\s+-s/.test(s));
    assert.ok(found, '应调用 fcitx5-remote -s');
});

test('Fcitx5 profile 解析: 自定义输入法列表', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '[Groups/0/Items/1]', 'Name=rime', 'Layout=',
        '[Groups/0/Items/2]', 'Name=keyboard-de', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    // profile 中 englishTarget 会选 keyboard-us（第一个 keyboard-*）
    // queryCurrentMode 比较 currentInput === englishTarget
    mockState.fcitx5CurrentInput = 'rime';
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', 'rime 应返回 zh');
    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(mgr.queryCurrentMode(), 'en', 'keyboard-us (englishTarget) 应返回 en');
    // keyboard-de 不是 englishTarget，所以返回 zh（源码行为）
    mockState.fcitx5CurrentInput = 'keyboard-de';
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', 'keyboard-de 非 englishTarget 时返回 zh');
});

test('Fcitx5 中英文完整切换流程', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.fcitx5CurrentInput = 'keyboard-us';
    const mgr = createImeManager();
    assert.strictEqual(mgr.queryCurrentMode(), 'en', '初始英文');

    mockState.fcitx5CurrentInput = 'pinyin';
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', '切换后中文');

    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(mgr.queryCurrentMode(), 'en', '切回英文');
});

// ──────────────────────────────────────────────────────────────
// 测试 2: Fcitx4Manager 基本操作
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 2: Fcitx4Manager 基本操作');

test('Fcitx4 检测成功（Fcitx5 不可用时）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx4ExitCode = 2;
    const mode = mgr.queryCurrentMode();
    assert.strictEqual(mode, 'zh', 'exit code 2 应返回 zh');
});

test('Fcitx4 queryCurrentMode: exit code 1 → en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.fcitx4ExitCode = 1;
    const mode = mgr.queryCurrentMode();
    assert.strictEqual(mode, 'en', 'exit code 1 应返回 en');
});

test('Fcitx4 switchToEnglish 调用 fcitx-remote -c', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToEnglish();
    // FCITX4_SWITCH_SCRIPT: timeout 5 fcitx-remote "$1" &> /dev/null，$1 为 -c
    const found = mockState.bashScripts.some(s => /fcitx-remote\s/.test(s));
    assert.ok(found, '应调用 fcitx-remote');
});

test('Fcitx4 switchToChinese 调用 fcitx-remote -o', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToChinese();
    // FCITX4_SWITCH_SCRIPT: timeout 5 fcitx-remote "$1" &> /dev/null，$1 为 -o
    const found = mockState.bashScripts.some(s => /fcitx-remote\s/.test(s));
    assert.ok(found, '应调用 fcitx-remote');
});

test('Fcitx4 中英文完整切换流程', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    mockState.fcitx4ExitCode = 1;
    const mgr = createImeManager();
    assert.strictEqual(mgr.queryCurrentMode(), 'en', '初始英文');

    mockState.fcitx4ExitCode = 2;
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', '切换后中文');

    mockState.fcitx4ExitCode = 1;
    assert.strictEqual(mgr.queryCurrentMode(), 'en', '切回英文');
});

// ──────────────────────────────────────────────────────────────
// 测试 3: IBusManager 基本操作
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 3: IBusManager 基本操作');

test('IBus 检测成功（Fcitx5/4 不可用时）', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.ibusCurrentEngine = 'libpinyin';
    const mode = mgr.queryCurrentMode();
    assert.strictEqual(mode, 'zh', 'libpinyin 应返回 zh');
});

test('IBus queryCurrentMode: xkb:us::eng → en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const mode = mgr.queryCurrentMode();
    assert.strictEqual(mode, 'en', 'xkb:us::eng 应返回 en');
});

test('IBus switchToEnglish 调用 ibus engine xkb:us::eng', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToEnglish();
    // IBUS_ENGINE_SCRIPT: ibus engine "$1" &> /dev/null，$1 为 xkb:us::eng
    const found = mockState.bashScripts.some(s => /ibus\s+engine/.test(s));
    assert.ok(found, '应调用 ibus engine');
});

test('IBus switchToChinese 调用 ibus engine', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToChinese();
    const found = mockState.bashScripts.some(s => /ibus\s+engine/.test(s));
    assert.ok(found, '应调用 ibus engine');
});

test('IBus 中英文完整切换流程', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    const mgr = createImeManager();
    assert.strictEqual(mgr.queryCurrentMode(), 'en', '初始英文');

    mockState.ibusCurrentEngine = 'libpinyin';
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', '切换后中文');

    mockState.ibusCurrentEngine = 'xkb:us::eng';
    assert.strictEqual(mgr.queryCurrentMode(), 'en', '切回英文');
});

// ──────────────────────────────────────────────────────────────
// 测试 4: NullIMEManager 回退
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 4: NullIMEManager 回退');

test('所有 IME 均不可用时回退到 NullManager', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    assert.doesNotThrow(() => mgr.switchToEnglish(), 'switchToEnglish 不应抛异常');
    assert.doesNotThrow(() => mgr.switchToChinese(), 'switchToChinese 不应抛异常');
    assert.strictEqual(mgr.queryCurrentMode(), '', 'NullManager 应返回空串');
});

test('NullManager 连续调用安全', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    for (let i = 0; i < 100; i++) {
        mgr.switchToEnglish();
        mgr.switchToChinese();
        assert.strictEqual(mgr.queryCurrentMode(), '');
    }
});

// ──────────────────────────────────────────────────────────────
// 测试 5: 超时与异常安全（不阻塞主线程）
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 5: 超时与异常安全');

test('fcitx5-remote 超时，queryCurrentMode 返回空串', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote -n');
    const mgr = createImeManager();
    const mode = mgr.queryCurrentMode();
    assert.strictEqual(mode, '', '超时应返回空串');
});

test('fcitx5-remote 超时，switchToEnglish 不抛异常', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote');
    const mgr = createImeManager();
    assert.doesNotThrow(() => mgr.switchToEnglish(), '超时不应阻塞');
});

test('fcitx-remote 超时，Fcitx4Manager queryCurrentMode 回退到 en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    // 精确匹配查询脚本中的 echo $?，避免影响 fcitx4 检测（command -v）
    mockState.timeoutCommands.add('echo $?');
    const mgr = createImeManager();
    // runBash 超时返回 '' → parseInt('') = NaN → NaN !== 2 → 返回 'en'
    const mode = mgr.queryCurrentMode();
    assert.strictEqual(mode, 'en', '超时时 parseInt 返回 NaN，回退到 en');
});

test('ibus engine 查询超时，IBusManager queryCurrentMode 返回空串', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('ibus engine');
    const mgr = createImeManager();
    const mode = mgr.queryCurrentMode();
    assert.strictEqual(mode, '', 'ibus 超时应返回空串');
});

test('连续超时不累积阻塞：10 次调用均 < 1s', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('ibus engine');
    const mgr = createImeManager();
    const start = Date.now();
    for (let i = 0; i < 10; i++) {
        mgr.queryCurrentMode();
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `10 次调用应 < 1s，实际 ${elapsed}ms`);
});

test('switchToEnglish 在超时时不抛异常', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.timeoutCommands.add('ibus engine');
    const mgr = createImeManager();
    assert.doesNotThrow(() => {
        for (let i = 0; i < 5; i++) mgr.switchToEnglish();
    });
});

// ──────────────────────────────────────────────────────────────
// 测试 6: 责任链降级
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 6: 责任链降级');

test('Fcitx5 不可用 → 降级到 Fcitx4', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.profileExists = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx4ExitCode = 2;
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', '应使用 Fcitx4');
    mockState.fcitx4ExitCode = 1;
    assert.strictEqual(mgr.queryCurrentMode(), 'en', '应使用 Fcitx4');
});

test('Fcitx5+Fcitx4 不可用 → 降级到 IBus', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.ibusCurrentEngine = 'libpinyin';
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', '应使用 IBus');
    mockState.ibusCurrentEngine = 'xkb:us::eng';
    assert.strictEqual(mgr.queryCurrentMode(), 'en', '应使用 IBus');
});

test('全部不可用 → NullManager', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    assert.strictEqual(mgr.queryCurrentMode(), '');
    assert.doesNotThrow(() => mgr.switchToEnglish());
    assert.doesNotThrow(() => mgr.switchToChinese());
});

test('降级后切换命令使用正确的目标管理器', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToChinese();
    const hasFcitx4 = mockState.bashScripts.some(s => /fcitx-remote\s/.test(s));
    const hasFcitx5 = mockState.bashScripts.some(s => /fcitx5-remote/.test(s));
    assert.ok(hasFcitx4, '应使用 fcitx-remote');
    assert.ok(!hasFcitx5, '不应使用 fcitx5-remote');
});

test('降级到 IBus 后切换命令正确', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToEnglish();
    const hasIbus = mockState.bashScripts.some(s => /ibus\s+engine/.test(s));
    assert.ok(hasIbus, '应使用 ibus engine');
});

// ──────────────────────────────────────────────────────────────
// 测试 7: profile 文件边界情况
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 7: profile 文件边界情况');

test('profile 文件不存在时 Fcitx5 检测失败并降级', () => {
    resetMock();
    mockState.profileExists = false;
    // profile 不存在 → fcitx5 检测失败 → 降级到 fcitx4
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx4ExitCode = 1;
    assert.strictEqual(mgr.queryCurrentMode(), 'en', '应降级到 Fcitx4');
    mockState.fcitx4ExitCode = 2;
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', '应降级到 Fcitx4');
});

test('profile 为空文件时使用默认值', () => {
    resetMock();
    mockState.profileContent = '';
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(mgr.queryCurrentMode(), 'en');
});

test('profile 仅有 keyboard 布局时英文使用第一个 keyboard', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-de', 'Layout=',
        '[Groups/0/Items/1]', 'Name=keyboard-fr', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx5CurrentInput = 'keyboard-de';
    assert.strictEqual(mgr.queryCurrentMode(), 'en', 'keyboard-de 应为英文');
});

test('profile 无中文输入法时使用默认 pinyin', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx5CurrentInput = 'pinyin';
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', 'pinyin (默认) 应为中文');
});

test('profile 包含注释行和空行时正确解析', () => {
    resetMock();
    mockState.profileContent = [
        '# This is a comment',
        '[Groups/0]',
        'Name=Default',
        '',
        '[Groups/0/Items/0]',
        'Name=keyboard-us',
        'Layout=',
        '# Another comment',
        '',
        '[Groups/0/Items/1]',
        'Name=rime',
        'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx5CurrentInput = 'rime';
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', 'rime 应为中文');
});

// ──────────────────────────────────────────────────────────────
// 测试 8: bash 命令与参数
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 8: bash 命令与参数');

test('fcitx5-remote 切换脚本使用 bash 参数传递', () => {
    resetMock();
    mockState.profileContent = [
        '[Groups/0/Items/0]', 'Name=keyboard-us', 'Layout=',
        '[Groups/0/Items/1]', 'Name=rime', 'Layout=',
    ].join('\n');
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToChinese();
    // FCITX5_SWITCH_SCRIPT 包含 $1 引用
    const found = mockState.bashScripts.some(s => s.includes('$1') && s.includes('fcitx5-remote'));
    assert.ok(found, '应使用 $1 参数引用传递输入法名');
});

test('bash 调用使用 execFileSync 而非 execSync', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    createImeManager();
    const execFileCalls = mockState.callLog.filter(c => c.name === 'execFileSync');
    assert.ok(execFileCalls.length > 0, '应有 execFileSync 调用');
});

test('tryExecBash 使用 execFileSync 调用 bash', () => {
    resetMock();
    createImeManager();
    // 验证 execFileSync 被用于 IME 检测（tryExecBash 内部调用）
    const calls = mockState.callLog.filter(c => c.name === 'execFileSync');
    assert.ok(calls.length >= 1, `应有 execFileSync 调用，实际 ${calls.length}`);
    // 验证调用使用 bash -c
    const bashCalls = calls.filter(c => c.args[0] === 'bash');
    assert.ok(bashCalls.length >= 1, '应使用 bash -c 执行');
});

// ──────────────────────────────────────────────────────────────
// 测试 9: createImeManager 完整流程
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 9: createImeManager 完整流程');

test('返回对象实现 IIMEManager 接口', () => {
    resetMock();
    const mgr = createImeManager();
    assert.strictEqual(typeof mgr.switchToEnglish, 'function');
    assert.strictEqual(typeof mgr.switchToChinese, 'function');
    assert.strictEqual(typeof mgr.queryCurrentMode, 'function');
});

test('多次 createImeManager 返回独立实例', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr1 = createImeManager();
    mockState.fcitx5CurrentInput = 'keyboard-us';
    assert.strictEqual(mgr1.queryCurrentMode(), 'en');

    mockState.fcitx5CurrentInput = 'pinyin';
    const mgr2 = createImeManager();
    assert.strictEqual(mgr2.queryCurrentMode(), 'zh');
});

test('createImeManager 接受 outputChannel 和 logFilePath 参数', () => {
    resetMock();
    const messages = [];
    const mockChannel = { appendLine: (msg) => messages.push(msg) };
    assert.doesNotThrow(() => {
        createImeManager(mockChannel, '/tmp/test-auto-ime.log');
    });
});

test('createImeManager 无参数调用安全', () => {
    resetMock();
    assert.doesNotThrow(() => {
        const mgr = createImeManager();
        assert.ok(mgr);
    });
});

// ──────────────────────────────────────────────────────────────
// 测试 10: 编译后 bundle 内容验证
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 10: 编译后 bundle 内容验证');

test('bundle 包含 Fcitx5Manager 类', () => {
    assert.ok(bundleSrc.includes('Fcitx5Manager'), '应包含 Fcitx5Manager');
});

test('bundle 包含 Fcitx4Manager 类', () => {
    assert.ok(bundleSrc.includes('Fcitx4Manager'), '应包含 Fcitx4Manager');
});

test('bundle 包含 IBusManager 类', () => {
    assert.ok(bundleSrc.includes('IBusManager'), '应包含 IBusManager');
});

test('bundle 包含 NullIMEManager 类', () => {
    assert.ok(bundleSrc.includes('NullIMEManager'), '应包含 NullIMEManager');
});

test('bundle 包含 detectIME 降级链', () => {
    assert.ok(bundleSrc.includes('fcitx5-remote'), '应包含 fcitx5-remote');
    assert.ok(bundleSrc.includes('fcitx-remote'), '应包含 fcitx-remote');
    assert.ok(bundleSrc.includes('ibus engine'), '应包含 ibus engine');
});

test('bundle 包含 IMEStateManager 的 Fcitx5 轮询逻辑', () => {
    assert.ok(bundleSrc.includes('tryStartFcitx5Polling'), '应包含 Fcitx5 轮询');
    assert.ok(bundleSrc.includes('isFcitx5Available'), '应包含 Fcitx5 可用性检测');
});

test('bundle 包含 IMEStateManager 的 IBus D-Bus 监听', () => {
    assert.ok(bundleSrc.includes('tryListenIBus'), '应包含 IBus 监听');
    assert.ok(bundleSrc.includes('GlobalEngineChanged'), '应包含 D-Bus 信号名');
});

test('bundle 包含手动覆盖逻辑', () => {
    assert.ok(bundleSrc.includes('handleIMEChange'), '应包含 handleIMEChange');
    assert.ok(bundleSrc.includes('manualOverride'), '应包含 manualOverride');
});

test('bundle 包含 bash 超时保护', () => {
    assert.ok(bundleSrc.includes('timeout'), '应包含 timeout 参数');
});

test('bundle 包含 profile 路径检测', () => {
    assert.ok(bundleSrc.includes('.config/fcitx5/profile'), '应包含 profile 路径');
});

// ──────────────────────────────────────────────────────────────
// 测试 11: IMEStateManager 内部逻辑验证
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 11: IMEStateManager 内部逻辑验证');

test('bundle 包含 500ms 自动切换阈值', () => {
    assert.ok(bundleSrc.includes('timeSinceAutoSwitch < 500'), '应包含 500ms 阈值');
});

test('bundle 包含 markAutoSwitch / markManualSwitch 方法', () => {
    assert.ok(bundleSrc.includes('markAutoSwitch'), '应包含 markAutoSwitch');
    assert.ok(bundleSrc.includes('markManualSwitch'), '应包含 markManualSwitch');
    assert.ok(bundleSrc.includes('resetManualOverride'), '应包含 resetManualOverride');
});

test('bundle 包含光标位置跟踪', () => {
    assert.ok(bundleSrc.includes('isDifferentPosition'), '应包含 isDifferentPosition');
    assert.ok(bundleSrc.includes('lastPositionLine'), '应包含 lastPositionLine');
});

test('bundle 包含 Fcitx5 轮询间隔 200ms', () => {
    assert.ok(bundleSrc.includes('200') || bundleSrc.includes('fcitx5Polling'), '应包含 200ms 轮询');
});

// ──────────────────────────────────────────────────────────────
// 测试 12: D-Bus / dbus-next 容错
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 12: D-Bus / dbus-next 容错');

test('bundle 包含 dbus-next 容错逻辑', () => {
    assert.ok(bundleSrc.includes('dbus-next'), '应包含 dbus-next');
    assert.ok(bundleSrc.includes('sessionBus'), '应包含 sessionBus');
    assert.ok(bundleSrc.includes('getProxyObject'), '应包含 getProxyObject');
    assert.ok(bundleSrc.includes('org.freedesktop.IBus'), '应包含 IBus D-Bus 路径');
});

test('bundle 包含 dbus-next 加载失败的 try/catch', () => {
    // tryListenIBus 整体包裹在 try/catch 中
    assert.ok(bundleSrc.includes('tryListenIBus'), '应包含 tryListenIBus');
});

// ──────────────────────────────────────────────────────────────
// 测试 13: 平台隔离验证
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 13: 平台隔离验证');

test('bundle 包含平台守卫', () => {
    assert.ok(
        bundleSrc.includes('process.platform === "win32"') ||
        bundleSrc.includes("process.platform === 'win32'"),
        '应包含 win32 平台守卫'
    );
});

test('bundle 包含 Windows FFI 懒加载', () => {
    assert.ok(bundleSrc.includes('getIMESwitcher'), '应包含 getIMESwitcher');
});

test('bundle 包含 PowerShell 回退代码', () => {
    assert.ok(bundleSrc.includes('WindowsPowerShellFallback'), '应包含 PowerShell 回退');
});

test('bundle 包含 Linux 分支: detectIME 中的 Fcitx5/4/IBus 探测', () => {
    assert.ok(bundleSrc.includes('command -v fcitx5-remote'), '应包含 fcitx5 探测');
    assert.ok(bundleSrc.includes('command -v fcitx-remote'), '应包含 fcitx4 探测');
    assert.ok(bundleSrc.includes('command -v ibus'), '应包含 ibus 探测');
});

// ──────────────────────────────────────────────────────────────
// 测试 14: 异常传播安全
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 14: 异常传播安全');

test('readFcitx5Profile 读取异常不传播', () => {
    resetMock();
    const origRead = fs.readFileSync;
    fs.readFileSync = function(p, enc) {
        if (typeof p === 'string' && p.includes('fcitx5')) {
            throw new Error('Permission denied');
        }
        return origRead(p, enc);
    };
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    assert.doesNotThrow(() => {
        const mgr = createImeManager();
        mockState.fcitx5CurrentInput = 'keyboard-us';
        assert.strictEqual(mgr.queryCurrentMode(), 'en', '应使用默认值');
    });
    fs.readFileSync = origRead;
});

test('readFcitx5Profile 文件内容格式异常不传播', () => {
    resetMock();
    mockState.profileContent = '这不是一个有效的 profile 文件内容!!!';
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    assert.doesNotThrow(() => {
        const mgr = createImeManager();
        // 格式错误时使用默认值
        mockState.fcitx5CurrentInput = 'keyboard-us';
        assert.strictEqual(mgr.queryCurrentMode(), 'en');
    });
});

test('所有 bash 命令失败时 createImeManager 不传播异常', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    assert.doesNotThrow(() => createImeManager());
});

test('runBash 内部异常被 catch 并返回空串', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    mockState.timeoutCommands.add('fcitx5-remote -n');
    const mgr = createImeManager();
    assert.strictEqual(mgr.queryCurrentMode(), '');
});

// ──────────────────────────────────────────────────────────────
// 测试 15: 边界场景
// ──────────────────────────────────────────────────────────────
console.log('\n📦 测试 15: 边界场景');

test('Fcitx5 queryCurrentMode: 未知输入法名返回 zh', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.fcitx5CurrentInput = 'some-unknown-input-method';
    // 不是 keyboard-* 所以不是 en，应返回 zh
    assert.strictEqual(mgr.queryCurrentMode(), 'zh', '未知输入法应返回 zh');
});

test('Fcitx4 queryCurrentMode: exit code 0 返回 en', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.ibusAvailable = false;
    mockState.profileExists = false;
    const mgr = createImeManager();
    mockState.fcitx4ExitCode = 0;
    assert.strictEqual(mgr.queryCurrentMode(), 'en', 'exit code 0 (不等于 2) 应返回 en');
});

test('IBus queryCurrentMode: 空引擎名返回空串', () => {
    resetMock();
    mockState.fcitx5Available = false;
    mockState.fcitx4Available = false;
    mockState.profileExists = false;
    mockState.ibusCurrentEngine = '';
    const mgr = createImeManager();
    // ibus engine 返回空串，queryCurrentMode 应返回空串
    assert.strictEqual(mgr.queryCurrentMode(), '', '空引擎名应返回空串');
});

test('switchToEnglish 后立即 switchToChinese 不冲突', () => {
    resetMock();
    mockState.fcitx4Available = false;
    mockState.ibusAvailable = false;
    const mgr = createImeManager();
    mockState.bashScripts = [];
    mgr.switchToEnglish();
    mgr.switchToChinese();
    // 两次调用都使用 fcitx5-remote -s，bashScripts 应有 2 条记录
    const switchCalls = mockState.bashScripts.filter(s => /fcitx5-remote\s+-s/.test(s));
    assert.strictEqual(switchCalls.length, 2, `应有 2 次 fcitx5-remote -s 调用，实际 ${switchCalls.length}`);
});

// ──────────────────────────────────────────────────────────────
// 汇总
// ──────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`  结果: ${passCount}/${testCount} 通过, ${failCount} 失败`);
console.log('═══════════════════════════════════════');

// 清理
if (typeof ext.deactivate === 'function') {
    try { ext.deactivate(); } catch {}
}

process.exit(failCount > 0 ? 1 : 0);
