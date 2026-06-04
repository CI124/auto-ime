/**
 * Windows IME FFI 绑定 (koffi)
 * 替代 PowerShell 方案，性能从 ~100ms 提升到 <1ms
 */

import koffi from 'koffi';

// ============ Win32 类型定义 ============

const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
const HWND = koffi.alias('HWND', HANDLE);
const HKL = koffi.alias('HKL', 'uint64');
const DWORD = koffi.alias('DWORD', 'uint32_t');
const UINT = koffi.alias('UINT', 'unsigned int');
const WPARAM = koffi.alias('WPARAM', 'uint64');
const LPARAM = koffi.alias('LPARAM', 'int64');
const LRESULT = koffi.alias('LRESULT', 'int64');
const BOOL = koffi.alias('BOOL', 'int32_t');

// ============ 加载 DLL ============

const user32 = koffi.load('user32.dll');
const imm32 = koffi.load('imm32.dll');
const kernel32 = koffi.load('kernel32.dll');

// ============ user32.dll 函数绑定 ============

export const GetForegroundWindow = user32.func(
    'HWND __stdcall GetForegroundWindow()'
);

export const GetWindowThreadProcessId = user32.func(
    'DWORD __stdcall GetWindowThreadProcessId(HWND, _Out_ DWORD*)'
);

export const GetKeyboardLayout = user32.func(
    'HKL __stdcall GetKeyboardLayout(DWORD)'
);

export const GetKeyboardLayoutList = user32.func(
    'int __stdcall GetKeyboardLayoutList(int, void*)'
);

export const SendMessageW = user32.func(
    'LRESULT __stdcall SendMessageW(HWND, UINT, WPARAM, LPARAM)'
);

export const PostMessageW = user32.func(
    'BOOL __stdcall PostMessageW(HWND, UINT, WPARAM, LPARAM)'
);

export const AttachThreadInput = user32.func(
    'BOOL __stdcall AttachThreadInput(DWORD, DWORD, BOOL)'
);

export const GetCurrentThreadId = kernel32.func(
    'DWORD __stdcall GetCurrentThreadId()'
);

// ============ imm32.dll 函数绑定 ============

export const ImmGetContext = imm32.func(
    'void* __stdcall ImmGetContext(HWND)'
);

export const ImmReleaseContext = imm32.func(
    'BOOL __stdcall ImmReleaseContext(HWND, void*)'
);

export const ImmGetConversionStatus = imm32.func(
    'BOOL __stdcall ImmGetConversionStatus(void*, _Out_ uint32_t*, _Out_ uint32_t*)'
);

export const ImmSetConversionStatus = imm32.func(
    'BOOL __stdcall ImmSetConversionStatus(void*, uint32_t, uint32_t)'
);

export const ImmGetOpenStatus = imm32.func(
    'BOOL __stdcall ImmGetOpenStatus(void*)'
);

export const ImmSetOpenStatus = imm32.func(
    'BOOL __stdcall ImmSetOpenStatus(void*, BOOL)'
);

// ============ Win32 常量 ============

export const WM_INPUTLANGCHANGEREQUEST = 0x0050;

// ImmGetConversionStatus / ImmSetConversionStatus 常量
export const IME_CMODE_ALPHANUMERIC = 0x0000;  // 英文模式
export const IME_CMODE_NATIVE = 0x0001;         // 中文/日文等本地模式
export const IME_CMODE_CHINESE = 0x0001;        // 中文模式（同 NATIVE）

// ============ 辅助函数 ============

/**
 * 获取真正的前台窗口句柄（处理线程输入附加）
 */
export function getTrueForegroundWindow(): bigint {
    let hwnd = BigInt(GetForegroundWindow() as any);
    if (!hwnd) return 0n;

    const tidBuf = [0];
    GetWindowThreadProcessId(hwnd, tidBuf);
    const targetTid = Number(tidBuf[0]);
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

    const tidBuf = [0];
    GetWindowThreadProcessId(hwnd, tidBuf);
    const hkl = BigInt(GetKeyboardLayout(Number(tidBuf[0])) as any);
    return Number(hkl & 0xFFFFn);
}

// 支持的英文 Language ID 列表
const ENGLISH_LANG_IDS = [1033];  // 英语(美国)

// 支持的中文 Language ID 列表（简体优先）
const CHINESE_LANG_IDS = [2052, 1028, 3076, 5124, 4100];  // 简体(大陆), 繁体(台湾), 繁体(香港), 繁体(澳门), 中文(新加坡)

/**
 * 判断 Language ID 是否为英文
 */
export function isEnglishLangId(langId: number): boolean {
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
export function enumerateKeyboardLayouts(): { enLangId: number; zhLangId: number } {
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

    return { enLangId, zhLangId };
}

/**
 * 切换键盘布局（通过 WM_INPUTLANGCHANGEREQUEST）
 */
export function switchKeyboardLayout(langId: number): void {
    const hwnd = getTrueForegroundWindow();
    if (!hwnd) return;
    PostMessageW(hwnd, WM_INPUTLANGCHANGEREQUEST, BigInt(0), BigInt(langId));
}

// ============ IMM32 输入法模式查询/切换 ============

/**
 * 查询当前输入法的中文/英文模式
 * 优先使用 IMM32 ImmGetConversionStatus，失败时回退到 Language ID 判断
 * 返回 'zh' | 'en'，仅当两种方法都失败时返回 null
 */
export function queryIMEMode(): 'zh' | 'en' | null {
    const hwnd = getTrueForegroundWindow();
    if (!hwnd) return null;

    // 第一优先：IMM32（适用于传统 IME，如微软拼音旧版）
    const hImmCtx = ImmGetContext(hwnd);
    if (hImmCtx) {
        const convBuf = [0];
        const sentBuf = [0];
        const ok = ImmGetConversionStatus(hImmCtx, convBuf, sentBuf);
        ImmReleaseContext(hwnd, hImmCtx);

        if (ok) {
            return (Number(convBuf[0]) & IME_CMODE_NATIVE) !== 0 ? 'zh' : 'en';
        }
    }

    // 第二优先：Language ID（适用于 TSF IME 如微软拼音，ImmGetContext 返回 null）
    const langId = getCurrentLanguageId();
    if (langId !== 0) {
        if (isChineseLangId(langId)) return 'zh';
        if (isEnglishLangId(langId)) return 'en';
    }

    return null;
}

/**
 * 通过 TSF compartment 读取输入法模式（微软拼音等 TSF 输入法）
 * 返回 'zh' | 'en'，失败返回 null（调用方应降级到 IMM32）
 */
export function queryTSFMode(): 'zh' | 'en' | null {
    try {
        const tsfFfi = require('./tsf-ffi');
        return tsfFfi.queryTSFMode();
    } catch {
        return null;
    }
}

/**
 * 通过 TSF compartment 设置输入法模式
 * 返回是否成功
 */
export function setTSFMode(chinese: boolean): boolean {
    try {
        const tsfFfi = require('./tsf-ffi');
        return tsfFfi.setTSFMode(chinese);
    } catch {
        return false;
    }
}

/**
 * 通过持久化 PowerShell 管道查询 TSF 模式（异步，~2-5ms）
 * 返回 'zh' | 'en' | null
 */
export async function queryTSFModeAsync(): Promise<'zh' | 'en' | null> {
    try {
        const tsfFfi = require('./tsf-ffi');
        return await tsfFfi.queryTSFModeAsync();
    } catch {
        return null;
    }
}

/**
 * 通过持久化 PowerShell 管道设置 TSF 模式（异步，~2-5ms）
 * 返回是否成功
 */
export async function setTSFModeAsync(chinese: boolean): Promise<boolean> {
    try {
        const tsfFfi = require('./tsf-ffi');
        return await tsfFfi.setTSFModeAsync(chinese);
    } catch {
        return false;
    }
}

/**
 * 释放持久化 PowerShell 管道
 */
export function disposeTSFPipe(): void {
    try {
        const tsfFfi = require('./tsf-ffi');
        tsfFfi.disposeTSFPipe();
    } catch {}
}

/**
 * 设置输入法模式（通过 IMM32 ImmSetConversionStatus）
 * mode: true=中文, false=英文
 * 返回是否成功
 */
export function setIMEMode(chinese: boolean): boolean {
    const hwnd = getTrueForegroundWindow();
    if (!hwnd) return false;

    const hImmCtx = ImmGetContext(hwnd);
    if (!hImmCtx) return false;

    const convBuf = [0];
    const sentBuf = [0];
    ImmGetConversionStatus(hImmCtx, convBuf, sentBuf);

    const currentConv = Number(convBuf[0]);
    if (chinese) {
        convBuf[0] = currentConv | IME_CMODE_NATIVE;
    } else {
        convBuf[0] = currentConv & ~IME_CMODE_NATIVE;
    }

    const ok = ImmSetConversionStatus(hImmCtx, convBuf[0], sentBuf[0]);
    ImmReleaseContext(hwnd, hImmCtx);
    return ok !== 0;
}

/**
 * 检测当前窗口是否使用 TSF 输入法（通过 ITfThreadMgr COM 接口）
 * 使用 koffi 直接调用 ole32.dll COM 函数
 */
export function isTSFEnabled(): boolean {
    try {
        const tsfFfi = require('./tsf-ffi');
        return tsfFfi.detectTSF();
    } catch {
        return false;
    }
}
