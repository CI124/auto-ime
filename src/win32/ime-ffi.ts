/**
 * Windows IME FFI 绑定 (koffi)
 * 替代 PowerShell 方案，性能从 ~100ms 提升到 <1ms
 *
 * 只绑定真正用到的 API：键盘布局枚举 / 查询 / 切换（user32）与热键注入。
 * IMM32 的 ImmGetContext / ImmSetConversionStatus 一类转换状态读写已全部移除：
 * VS Code 是 TSF-only 宿主，ImmGetContext 恒返回 0，对中文/英文模式既读不到也写不动。
 */

import koffi from 'koffi';
import { LogSink } from '../infra/logger';

// ============ Win32 类型定义 ============

const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
const HWND = koffi.alias('HWND', HANDLE);
const HKL = koffi.alias('HKL', 'uint64');
const DWORD = koffi.alias('DWORD', 'uint32_t');
const UINT = koffi.alias('UINT', 'unsigned int');
const WPARAM = koffi.alias('WPARAM', 'uint64');
const LPARAM = koffi.alias('LPARAM', 'int64');
const BOOL = koffi.alias('BOOL', 'int32_t');

// ============ 加载 DLL ============

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

// ============ user32.dll 函数绑定 ============

const GetForegroundWindow = user32.func(
    'HWND __stdcall GetForegroundWindow()'
);

const GetWindowThreadProcessId = user32.func(
    'DWORD __stdcall GetWindowThreadProcessId(HWND, _Out_ DWORD*)'
);

const GetKeyboardLayout = user32.func(
    'HKL __stdcall GetKeyboardLayout(DWORD)'
);

const GetKeyboardLayoutList = user32.func(
    'int __stdcall GetKeyboardLayoutList(int, void*)'
);

const PostMessageW = user32.func(
    'BOOL __stdcall PostMessageW(HWND, UINT, WPARAM, LPARAM)'
);

const AttachThreadInput = user32.func(
    'BOOL __stdcall AttachThreadInput(DWORD, DWORD, BOOL)'
);

const GetCurrentThreadId = kernel32.func(
    'DWORD __stdcall GetCurrentThreadId()'
);

// ============ Win32 常量 ============

const WM_INPUTLANGCHANGEREQUEST = 0x0050;

// ============ 辅助函数 ============

/**
 * 获取真正的前台窗口句柄（处理线程输入附加）
 */
function getTrueForegroundWindow(): bigint {
    let hwnd = BigInt(GetForegroundWindow() as any);
    if (!hwnd) return 0n;

    const pidBuf = [0];
    const targetTid = GetWindowThreadProcessId(hwnd, pidBuf) as number; // return value = Thread ID
    const currentTid = Number(GetCurrentThreadId() as any);

    if (currentTid !== targetTid) {
        const attached = AttachThreadInput(currentTid, targetTid, 1);
        if (attached) {
            hwnd = BigInt(GetForegroundWindow() as any);
            AttachThreadInput(currentTid, targetTid, 0);
        }
    }

    return hwnd;
}

/**
 * 查询当前键盘布局的 Language ID
 */
export function getCurrentLanguageId(): number {
    const hwnd = getTrueForegroundWindow();
    if (!hwnd) return 0;

    const pidBuf = [0];
    const tid = GetWindowThreadProcessId(hwnd, pidBuf) as number; // return value = Thread ID
    const hkl = BigInt(GetKeyboardLayout(tid) as any);
    return Number(hkl & 0xFFFFn);
}

// 支持的英文 Language ID 列表
const ENGLISH_LANG_IDS = [1033];  // 英语(美国)

// 支持的中文 Language ID 列表（简体优先）
const CHINESE_LANG_IDS = [2052, 1028, 3076, 5124, 4100];  // 简体(大陆), 繁体(台湾), 繁体(香港), 繁体(澳门), 中文(新加坡)

/**
 * 判断 Language ID 是否为英文
 */
function isEnglishLangId(langId: number): boolean {
    return ENGLISH_LANG_IDS.includes(langId);
}

/**
 * 判断 Language ID 是否为中文（简体或繁体）
 */
export function isChineseLangId(langId: number): boolean {
    return CHINESE_LANG_IDS.includes(langId);
}

/**
 * 枚举已安装的键盘布局，返回英文和中文的 Language ID
 */
export function enumerateKeyboardLayouts(logger?: LogSink): { enLangId: number; zhLangId: number } {
    const count = GetKeyboardLayoutList(0, null);
    if (count <= 0) return { enLangId: 0, zhLangId: 0 };

    // 分配缓冲区存储 HKL 值（每个 8 字节）
    const buf = Buffer.alloc(count * 8);
    GetKeyboardLayoutList(count, buf);

    let enLangId = 0;
    let zhLangId = 0;

    for (let i = 0; i < count; i++) {
        const hkl = buf.readBigUInt64LE(i * 8);
        const langId = Number(hkl & 0xFFFFn);
        if (isEnglishLangId(langId) && enLangId === 0) enLangId = langId;
        if (isChineseLangId(langId) && zhLangId === 0) zhLangId = langId;
    }

    logger?.info(`[FFI] Keyboard layouts: en=${enLangId}, zh=${zhLangId}, total=${count}`);
    return { enLangId, zhLangId };
}

/**
 * 切换键盘布局（通过 WM_INPUTLANGCHANGEREQUEST）
 */
export function switchKeyboardLayout(langId: number, logger?: LogSink): void {
    const hwnd = getTrueForegroundWindow();
    if (!hwnd) {
        logger?.warn('[FFI] switchKeyboardLayout: no foreground window');
        return;
    }
    PostMessageW(hwnd, WM_INPUTLANGCHANGEREQUEST, BigInt(0), BigInt(langId));
}

// ============ 单键盘切换：模拟 IME 切换热键 ============

// 为什么用「模拟切换热键」而不是直接写 TSF compartment？
// 实测（Windows 11 26200）证明：从扩展宿主进程写 GUID_COMPARTMENT_KEYBOARD_OPENCLOSE
// 全局 compartment 并不能改变前台应用的中英状态——该状态是「线程级/应用级」的，而扩展宿主
// 与编辑器渲染进程是两个不同的进程。对 TSF-only 应用（VS Code / Electron）ImmGetContext
// 恒返回 0，IMM32 也读不到、写不动。唯一可靠的跨进程手段是让 IME 自己翻转：向前台窗口注入
// 切换热键（Shift 或 Ctrl+Space），由 IME 内部处理。
// 局限：这是「翻转」而非「绝对设置」，且无法跨进程读取真实状态，扩展只能内部跟踪目标状态。

export type ToggleKey = 'shift' | 'ctrl-space';

const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_SPACE = 0x20;

// keybd_event 的 dwFlags：0 = 按下，KEYEVENTF_KEYUP = 抬起
const KEYEVENTF_KEYDOWN = 0;
const KEYEVENTF_KEYUP = 0x02;

const keybdEvent = user32.func(
    'void __stdcall keybd_event(uint8_t, uint8_t, uint32_t, uint64)'
);

/**
 * 向前台窗口注入一次 IME 切换热键（让 IME 自己翻转中英）。
 * 同步注入、立即返回；实际翻转由 IME 在后台处理。
 */
export function sendImeToggle(key: ToggleKey, logger?: LogSink): void {
    // ctrl-space 需保持 Ctrl 贯穿 Space 的按下/抬起顺序，因此不能拆成两次 tap()
    if (key === 'ctrl-space') {
        keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYDOWN, 0n);
        keybdEvent(VK_SPACE, 0, KEYEVENTF_KEYDOWN, 0n);
        keybdEvent(VK_SPACE, 0, KEYEVENTF_KEYUP, 0n);
        keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0n);
    } else {
        // 默认：Shift（微软拼音 Win11 默认的中英切换键）
        keybdEvent(VK_SHIFT, 0, KEYEVENTF_KEYDOWN, 0n);
        keybdEvent(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0n);
    }
    logger?.debug(`[FFI] sendImeToggle(${key})`);
}
