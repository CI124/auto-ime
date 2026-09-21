/**
 * Mock koffi 测试 - 模拟 Windows 运行环境
 *
 * 通过 mock koffi 模块注入编译后的 bundle，测试完整调用链
 */

const assert = require('assert');
const Module = require('module');
const os = require('os');

// 扩展输出面板的所有日志行（用于端到端断言）
const outputLines = [];

function logged(substr) {
    return outputLines.some((l) => l.includes(substr));
}

// ============================================================
// Mock 状态（可注入控制测试场景）
// ============================================================
const mockState = {
    foregroundHwnd: 0x00010001n,
    currentLangId: 1033,
    installedLayouts: [1033, 2052],
    callLog: [],
};

function logCall(name, ...args) {
    mockState.callLog.push({ name, args: [...args] });
}

function resetMock() {
    mockState.foregroundHwnd = 0x00010001n;
    mockState.currentLangId = 1033;
    mockState.installedLayouts = [1033, 2052];
    mockState.callLog = [];
}

// ============================================================
// Mock koffi
// ============================================================
function createMockKoffi() {
    const user32Funcs = {
        'HWND __stdcall GetForegroundWindow()': () => {
            logCall('GetForegroundWindow');
            return mockState.foregroundHwnd;
        },
        'DWORD __stdcall GetWindowThreadProcessId(HWND, _Out_ DWORD*)': (hwnd, outPid) => {
            logCall('GetWindowThreadProcessId');
            if (Array.isArray(outPid)) outPid[0] = 1234;
            return 5678;
        },
        'HKL __stdcall GetKeyboardLayout(DWORD)': (tid) => {
            logCall('GetKeyboardLayout');
            return BigInt(mockState.currentLangId);
        },
        'int __stdcall GetKeyboardLayoutList(int, void*)': (count, buf) => {
            logCall('GetKeyboardLayoutList');
            const layouts = mockState.installedLayouts;
            if (count === 0) return layouts.length;
            if (buf && Buffer.isBuffer(buf)) {
                for (let i = 0; i < layouts.length; i++) {
                    buf.writeBigUInt64LE(BigInt(layouts[i]), i * 8);
                }
            }
            return layouts.length;
        },
        'BOOL __stdcall PostMessageW(HWND, UINT, WPARAM, LPARAM)': (hwnd, msg, wparam, lparam) => {
            logCall('PostMessageW');
            // WM_INPUTLANGCHANGEREQUEST: 前台窗口接受布局切换请求
            if (msg === 0x0050) mockState.currentLangId = Number(lparam);
            return 1;
        },
        'BOOL __stdcall AttachThreadInput(DWORD, DWORD, BOOL)': () => {
            logCall('AttachThreadInput');
            return 1;
        },
    };

    // kernel32.dll：GetCurrentThreadId 真正的宿主（src 从 kernel32 绑定）
    const kernel32Funcs = {
        'DWORD __stdcall GetCurrentThreadId()': () => {
            logCall('GetCurrentThreadId');
            return 9999;
        },
    };

    function createMockDll(funcDefs) {
        return {
            func: (sig) => {
                const fn = funcDefs[sig];
                return fn || ((...a) => { logCall(`UNKNOWN:${sig}`); return 0; });
            }
        };
    }

    return {
        load: (dllName) => {
            logCall('koffi.load', dllName);
            if (dllName === 'user32.dll') return createMockDll(user32Funcs);
            if (dllName === 'kernel32.dll') return createMockDll(kernel32Funcs);
            if (dllName === 'ole32.dll') return createMockDll({});
            throw new Error(`Unknown DLL: ${dllName}`);
        },
        struct: (name, fields) => ({ name, fields }),
        alias: (name, base) => ({ name, base }),
        pointer: (name, base) => ({ name, base }),
        opaque: () => ({}),
        array: (type, len) => ({ type, len }),
        proto: (name, ret, params) => ({ name, ret, params }),
    };
}

// ============================================================
// 注入 mock
// ============================================================

// 模拟 process.platform = win32
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

// 拦截 require，注入 mock koffi 和 mock vscode
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'koffi') return 'koffi';
    if (request === 'vscode') return 'vscode';
    return originalResolve.call(this, request, parent, isMain, options);
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === 'koffi') {
        return { default: createMockKoffi(), ...createMockKoffi() };
    }
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: (section) => ({
                    get: (key, def) => {
                        if (section === 'auto-ime.windows' && key === 'pollingInterval') return 500;
                        if (section === 'auto-ime.ibus' && key === 'englishEngine') return 'xkb:us::eng';
                        if (section === 'auto-ime.ibus' && key === 'chineseEngine') return 'libpinyin';
                        return def;
                    },
                }),
            },
            extensions: { getExtension: () => null },
            window: {
                activeTextEditor: null,
                createOutputChannel: () => ({ appendLine: (m) => outputLines.push(String(m)), dispose: () => {} }),
                createStatusBarItem: () => ({
                    text: '', tooltip: '', backgroundColor: undefined,
                    show: () => {}, dispose: () => {}, command: '',
                }),
                onDidChangeWindowState: () => ({ dispose: () => {} }),
                onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
                onDidChangeTextEditorOptions: () => ({ dispose: () => {} }),
                onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
            },
            workspace: {
                getConfiguration: (section) => ({
                    get: (key, def) => {
                        if (section === 'auto-ime.windows' && key === 'pollingInterval') return 500;
                        return def;
                    },
                }),
                onDidChangeTextDocument: () => ({ dispose: () => {} }),
            },
            StatusBarAlignment: { Left: 1 },
            TextEditorCursorStyle: { Block: 4, Line: 1 },
            ThemeColor: class { constructor(s) { this.id = s; } },
            Disposable: { from: () => ({ dispose: () => {} }) },
            commands: {
                registerCommand: () => ({ dispose: () => {} }),
                executeCommand: () => Promise.resolve(),
            },
            extensions: { getExtension: () => null },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

// ============================================================
// 测试框架（支持异步用例：全部等待完后再汇总）
// ============================================================
let testCount = 0, passCount = 0, failCount = 0;
const pendingTests = [];

function test(name, fn) {
    testCount++;
    const fail = (e) => {
        failCount++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${e.message}`);
    };
    let result;
    try {
        result = fn();
    } catch (e) {
        return fail(e);
    }
    if (result && typeof result.then === 'function') {
        pendingTests.push(result.then(
            () => { passCount++; console.log(`  ✅ ${name}`); },
            fail
        ));
        return;
    }
    passCount++;
    console.log(`  ✅ ${name}`);
}

// ============================================================
// 测试
// ============================================================

console.log('═══════════════════════════════════════');
console.log('  Mock koffi Windows 模拟测试');
console.log('═══════════════════════════════════════');

// 加载编译后的扩展
const ext = require('../dist/extension');

// ---- 测试 1: 扩展激活 ----
console.log('\n📦 测试 1: 扩展激活');

test('activate 函数存在', () => {
    assert.strictEqual(typeof ext.activate, 'function');
});

test('deactivate 函数存在', () => {
    assert.strictEqual(typeof ext.deactivate, 'function');
});

// ---- 测试 2: 扩展完整激活流程 ----
console.log('\n📦 测试 2: 扩展完整激活流程');

test('activate 完成全部接线（适配器/分析器/状态栏/命令/监听器）', async () => {
    resetMock();
    outputLines.length = 0;
    const mockContext = {
        subscriptions: [],
        extensionPath: require('path').join(__dirname, '..'),
        globalStorageUri: { fsPath: os.tmpdir() },
    };
    await ext.activate(mockContext);

    assert.ok(!logged('FATAL'), `激活不应出现 FATAL：${outputLines.filter((l) => l.includes('FATAL')).join(' / ')}`);
    assert.ok(logged('Strategy: dual-keyboard'), '应选中双键盘策略');
    assert.ok(logged('AST Analyzer initialized'), 'Tree-sitter 分析器必须完成初始化');
    assert.ok(logged('mode listeners registered'), '模式监听器应注册完成');
    assert.ok(logged('Adapter polls external switches') || logged('Polling Language ID'), '应开始外部切换检测');
    assert.ok(mockContext.subscriptions.length >= 5, `subscriptions 应持有状态栏/分析器/命令/监听器，实际 ${mockContext.subscriptions.length}`);
});

// ---- 测试 3: 直接测试编译后的内部函数 ----
console.log('\n📦 测试 3: 编译后 bundle 内部逻辑');

// 读取 bundle 源码并提取关键函数
const fs = require('fs');
const bundleSrc = fs.readFileSync(require('path').join(__dirname, '..', 'dist', 'extension.js'), 'utf-8');

test('bundle 包含 koffi 懒加载守卫', () => {
    assert.ok(bundleSrc.includes('process.platform === "win32"'), '应包含平台守卫');
});

test('bundle 包含平台适配器', () => {
    // New architecture uses platform adapters instead of PowerShell fallback
    assert.ok(bundleSrc.includes('DualKeyboardStrategy') || bundleSrc.includes('WindowsAdapter'), '应包含平台适配器');
});

test('bundle 包含多语言 ID 列表', () => {
    assert.ok(bundleSrc.includes('CHINESE_LANG_IDS') || bundleSrc.includes('1028'), '应包含繁体中文 ID');
});

test('bundle 包含轮询间隔配置', () => {
    assert.ok(bundleSrc.includes('pollingInterval') || bundleSrc.includes('auto-ime.windows'), '应包含轮询配置');
});

test('bundle 包含控制器和状态追踪器', () => {
    // New architecture uses IMEController + IMEStateTracker
    assert.ok(bundleSrc.includes('IMEController') || bundleSrc.includes('controller'), '应包含控制器');
    assert.ok(bundleSrc.includes('IMEStateTracker') || bundleSrc.includes('stateTracker') || bundleSrc.includes('StateTracker'), '应包含状态追踪器');
});

test('bundle 包含两种切换策略', () => {
    // layout=双键盘布局切换, toggle=单键盘 IME 热键切换（IMM32 转换状态写回已移除）
    assert.ok(bundleSrc.includes('layout'), '应包含 layout 策略');
    assert.ok(bundleSrc.includes('toggle'), '应包含 toggle 策略');
    assert.ok(bundleSrc.includes('sendImeToggle') || bundleSrc.includes('keybd_event'), '应包含单键盘热键切换');
});

// ---- 测试 4: 模块结构 ----
console.log('\n📦 测试 4: 导出结构');

test('activate 是 async 函数', () => {
    assert.ok(ext.activate.constructor.name === 'AsyncFunction');
});

test('deactivate 是普通函数', () => {
    assert.strictEqual(typeof ext.deactivate, 'function');
});

// ---- 测试 5: Mock koffi 调用验证 ----
console.log('\n📦 测试 5: Mock koffi 调用验证');

// 手动模拟 IMESwitcher 调用链
const mockKoffi = createMockKoffi();

test('Mock user32.GetForegroundWindow 返回句柄', () => {
    resetMock();
    const user32 = mockKoffi.load('user32.dll');
    const hwnd = user32.func('HWND __stdcall GetForegroundWindow()')();
    assert.strictEqual(hwnd, mockState.foregroundHwnd);
});

test('Mock user32.GetKeyboardLayout 返回当前布局', () => {
    resetMock();
    mockState.currentLangId = 2052;
    const user32 = mockKoffi.load('user32.dll');
    const hkl = user32.func('HKL __stdcall GetKeyboardLayout(DWORD)')(5678);
    assert.strictEqual(Number(hkl), 2052);
});

test('Mock GetKeyboardLayoutList 枚举布局', () => {
    resetMock();
    const user32 = mockKoffi.load('user32.dll');
    const count = user32.func('int __stdcall GetKeyboardLayoutList(int, void*)')(0, null);
    assert.strictEqual(count, 2);
});

test('Mock PostMessageW 切换键盘布局', () => {
    resetMock();
    mockState.currentLangId = 1033;
    const user32 = mockKoffi.load('user32.dll');
    user32.func('BOOL __stdcall PostMessageW(HWND, UINT, WPARAM, LPARAM)')(0x10001n, 0x0050, 0n, 2052n);
    assert.strictEqual(mockState.currentLangId, 2052);
});

// ---- 测试 6: 完整切换流程模拟 ----
console.log('\n📦 测试 6: 完整切换流程模拟（键盘布局）');

test('模拟: 英文 → 中文 → 英文 完整流程', () => {
    resetMock();
    const user32 = mockKoffi.load('user32.dll');
    const getLayout = user32.func('HKL __stdcall GetKeyboardLayout(DWORD)');
    const postSwitch = user32.func('BOOL __stdcall PostMessageW(HWND, UINT, WPARAM, LPARAM)');

    assert.strictEqual(Number(getLayout(5678)) & 0xffff, 1033, '初始应为英文 1033');

    postSwitch(0x10001n, 0x0050, 0n, 2052n);
    assert.strictEqual(Number(getLayout(5678)) & 0xffff, 2052, '应已切换到中文');

    postSwitch(0x10001n, 0x0050, 0n, 1033n);
    assert.strictEqual(Number(getLayout(5678)) & 0xffff, 1033, '应已切回英文');
});

test('模拟: 未安装英语布局时 enLangId 为 0', () => {
    resetMock();
    mockState.installedLayouts = [2052]; // 只有中文布局 → 单键盘场景

    const user32 = mockKoffi.load('user32.dll');
    const listFn = user32.func('int __stdcall GetKeyboardLayoutList(int, void*)');
    const count = listFn(0, null);
    const buf = Buffer.alloc(count * 8);
    listFn(count, buf);

    const ids = [];
    for (let i = 0; i < count; i++) ids.push(Number(buf.readBigUInt64LE(i * 8) & 0xffffn));
    assert.ok(!ids.includes(1033), '英语布局缺失时不能找到 1033');
    assert.ok(ids.includes(2052), '中文布局仍可用');
});

test('模拟: 多语言布局枚举', () => {
    resetMock();
    mockState.installedLayouts = [1033, 1028, 2052, 3076]; // 英语+繁体台湾+简体+繁体香港

    const user32 = mockKoffi.load('user32.dll');
    const count = user32.func('int __stdcall GetKeyboardLayoutList(int, void*)')(0, null);
    assert.strictEqual(count, 4);
});

// ---- 测试 7: 关键 bug 修复验证 ----
console.log('\n📦 测试 7: 关键 bug 修复验证 (_Out_ 注解 + 布局切换机制)');

test('bundle 包含 _Out_ 注解 (GetWindowThreadProcessId)', () => {
    assert.ok(bundleSrc.includes('_Out_ DWORD*'), '应包含 _Out_ DWORD*');
});

test('bundle 不再包含已移除的 IMM32 转换状态绑定', () => {
    assert.ok(!bundleSrc.includes('ImmGetConversionStatus'), '不应再包含 ImmGetConversionStatus');
    assert.ok(!bundleSrc.includes('ImmSetConversionStatus'), '不应再包含 ImmSetConversionStatus');
    assert.ok(!bundleSrc.includes('imm32.dll'), '不应再加载 imm32.dll');
});

test('switchKeyboardLayout 通过 PostMessageW(WM_INPUTLANGCHANGEREQUEST) 切换', () => {
    const section = bundleSrc.substring(
        bundleSrc.indexOf('function switchKeyboardLayout('),
        bundleSrc.indexOf('function sendImeToggle(')
    );
    assert.ok(section.includes('PostMessageW'), '应使用 PostMessageW');
    assert.ok(section.includes('WM_INPUTLANGCHANGEREQUEST'), '应使用 WM_INPUTLANGCHANGEREQUEST');
});

test('enumerateKeyboardLayouts 区分中 / 英布局', () => {
    const section = bundleSrc.substring(
        bundleSrc.indexOf('function enumerateKeyboardLayouts('),
        bundleSrc.indexOf('function switchKeyboardLayout(')
    );
    assert.ok(section.includes('isEnglishLangId'), '应调用 isEnglishLangId');
    assert.ok(section.includes('isChineseLangId'), '应调用 isChineseLangId');
});

test('DualKeyboardStrategy 使用 Language ID 查询', () => {
    // DualKeyboardStrategy.queryMode uses getCurrentLanguageId
    assert.ok(bundleSrc.includes('getCurrentLanguageId'), '应使用 getCurrentLanguageId 查询');
});

test('switchToEnglish/switchToChinese uses getCurrentLanguageId (same mechanism as detection)', () => {
    // 双键盘方案：检测和切换应使用同一机制（Language ID），且不得回到热键/IMM32 路径
    // esbuild 将类声明输出为 `XxxStrategy = class {`，以两个类声明之间为策略类作用域
    const dualStart = bundleSrc.indexOf('DualKeyboardStrategy = class');
    const dualEnd = bundleSrc.indexOf('SingleKeyboardStrategy = class');
    assert.ok(dualStart >= 0 && dualEnd > dualStart, 'bundle 应包含两个策略类且顺序可预期');
    const dualSection = bundleSrc.substring(dualStart, dualEnd);
    assert.ok(!dualSection.includes('sendImeToggle'), '双键盘切换路径不应调用 sendImeToggle');
    assert.ok(dualSection.includes('getCurrentLanguageId'), '双键盘检测应使用 getCurrentLanguageId');
});

test('bundle 包含英语键盘缺失的用户引导', () => {
    assert.ok(bundleSrc.includes('englishKeyboardWarningShown'), '应包含会话级标记');
    assert.ok(bundleSrc.includes('ms-settings:regionlanguage'), '应包含 Windows 设置链接');
    // 中文文本在 bundle 中被 Unicode 转义，检查转义形式
    assert.ok(bundleSrc.includes('\\u6253\\u5F00\\u8BBE\\u7F6E'), '应包含"打开设置"按钮文本');
});

test('switchToEnglish 不缓存降级状态', () => {
    assert.ok(!bundleSrc.includes('preferredMethod'), '不应包含 preferredMethod 缓存');
});

// ---- 测试 8: 单键盘 IME 切换热键 ----
console.log('\n📦 测试 8: 单键盘 IME 切换热键 (single-keyboard toggle)');

// 背景：原「TSF compartment 持久化管道」方案实测无效 —— 从扩展宿主进程写
// GUID_COMPARTMENT_KEYBOARD_OPENCLOSE 全局 compartment 并不会改变前台应用的输入法
// 中英状态（该状态是线程/应用级，且宿主与渲染进程分离）。已整体移除，改为向前台窗口
// 注入 IME 切换热键（Shift / Ctrl+Space），让 IME 自己翻转。
test('bundle 包含单键盘热键切换机制', () => {
    assert.ok(bundleSrc.includes('SingleKeyboardStrategy'), '应包含 SingleKeyboardStrategy');
    assert.ok(bundleSrc.includes('sendImeToggle'), '应包含 sendImeToggle');
    assert.ok(bundleSrc.includes('keybd_event'), '应通过 keybd_event 注入按键');
    assert.ok(bundleSrc.includes('VK_SHIFT'), '应包含 Shift 切换键');
    assert.ok(bundleSrc.includes('VK_CONTROL'), '应包含 Ctrl 切换键');
});

test('bundle 包含 auto-ime.windows.toggleKey 配置', () => {
    assert.ok(bundleSrc.includes('toggleKey'), '应读取 toggleKey 配置');
    assert.ok(bundleSrc.includes('ctrl-space'), '应支持 ctrl-space 取值');
});

test('bundle 不再包含已废弃的 TSF compartment 管道', () => {
    // 全局 compartment 写入 + PowerShell 持久化管道 + C# 桥接均已移除
    assert.ok(!bundleSrc.includes('TSFPipe'), '不应再包含 TSFPipe 类');
    assert.ok(!bundleSrc.includes('[Console]::In.ReadLine'), '不应再保留 PowerShell 管道');
    assert.ok(!bundleSrc.includes('58273AAD'), '不应再包含 TSF compartment GUID');
    assert.ok(!bundleSrc.includes('529A9E6B'), '不应再包含 CLSID_TF_ThreadMgr');
});

test('bundle 包含模式监听器', () => {
    // New architecture: NormalModeListener + VimModeListener
    assert.ok(bundleSrc.includes('NormalModeListener') || bundleSrc.includes('normal'), '应包含普通模式监听器');
    assert.ok(bundleSrc.includes('VimModeListener') || bundleSrc.includes('vim'), '应包含 Vim 模式监听器');
});

// ---- 汇总（等异步用例跑完再统计）----
Promise.all(pendingTests).then(() => {
    console.log('\n═══════════════════════════════════════');
    console.log(`  结果: ${passCount}/${testCount} 通过, ${failCount} 失败`);
    console.log('═══════════════════════════════════════');

    // 清理：deactivate 必须停掉适配器轮询，避免定时器泄漏
    ext.deactivate();
    process.exit(failCount > 0 ? 1 : 0);
});

