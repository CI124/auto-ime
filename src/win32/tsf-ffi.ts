/**
 * TSF (Text Services Framework) 检测 + 模式读写
 * 通过 COM 接口访问 ITfThreadMgr compartment 控制输入法中英文模式
 *
 * 使用 koffi 调用 ole32.dll COM 函数
 * 注意：仅 Windows 可用，调用方需确保平台匹配
 *
 * 性能优化：queryTSFModeAsync / setTSFModeAsync 使用持久化 PowerShell 进程（~2-5ms），
 * 同步版本仍逐次启动 PowerShell（~300ms），作为兼容回退。
 */

import koffi from 'koffi';
import { TSFPipe } from './tsf-pipe';

// ============ COM 基础设施 ============

const ole32 = koffi.load('ole32.dll');

const CoInitializeEx = ole32.func(
    'int __stdcall CoInitializeEx(void*, uint32_t)'
);

const CoCreateInstance = ole32.func(
    'int __stdcall CoCreateInstance(void*, void*, uint32_t, void*, void**)'
);

// ============ COM 类型注册 ============

// 注册 GUID 结构体（16 字节）
const GUID = koffi.struct('GUID', {
    Data1: 'uint32_t',
    Data2: 'uint16_t',
    Data3: 'uint16_t',
    Data4: koffi.array('uint8_t', 8)
});

// CLSID_TF_ThreadMgr = {529a9e6b-6587-4f23-ab9e-9c7d683e3c50}
const CLSID_TF_ThreadMgr: any = {
    Data1: 0x529a9e6b,
    Data2: 0x6587,
    Data3: 0x4f23,
    Data4: [0xab, 0x9e, 0x9c, 0x7d, 0x68, 0x3e, 0x3c, 0x50]
};

// IID_ITfThreadMgr = {aa80e801-2021-11d2-93e0-0060b067b86e}
const IID_ITfThreadMgr: any = {
    Data1: 0xaa80e801,
    Data2: 0x2021,
    Data3: 0x11d2,
    Data4: [0x93, 0xe0, 0x00, 0x60, 0xb0, 0x67, 0xb8, 0x6e]
};

// IID_ITfDocumentMgr = {aa80e7fd-2021-11d2-93e0-0060b067b86e}
const IID_ITfDocumentMgr: any = {
    Data1: 0xaa80e7fd,
    Data2: 0x2021,
    Data3: 0x11d2,
    Data4: [0x93, 0xe0, 0x00, 0x60, 0xb0, 0x67, 0xb8, 0x6e]
};

// IID_ITfCompartmentMgr = {7dcf57ac-18ad-438b-824d-979bffb74b7c}
const IID_ITfCompartmentMgr: any = {
    Data1: 0x7dcf57ac,
    Data2: 0x18ad,
    Data3: 0x438b,
    Data4: [0x82, 0x4d, 0x97, 0x9b, 0xff, 0xb7, 0x4b, 0x7c]
};

// IID_ITfCompartment = {bb08f7a9-607a-4384-8623-056892b64371}
const IID_ITfCompartment: any = {
    Data1: 0xbb08f7a9,
    Data2: 0x607a,
    Data3: 0x4384,
    Data4: [0x86, 0x23, 0x05, 0x68, 0x92, 0xb6, 0x43, 0x71]
};

// GUID_COMPARTMENT_KEYBOARD_OPENCLOSE = {58273AAD-01BB-4164-95C6-755BA0B5162D}
const GUID_COMPARTMENT_KEYBOARD_OPENCLOSE: any = {
    Data1: 0x58273aad,
    Data2: 0x01bb,
    Data3: 0x4164,
    Data4: [0x95, 0xc6, 0x75, 0x5b, 0xa0, 0xb5, 0x16, 0x2d]
};

const CLSCTX_INPROC_SERVER = 0x1;
const COINIT_APARTMENTTHREADED = 0x2;
const TF_TF_ENABLEPROFILE = 0x00000001;

// ============ COM 接口定义（保留参考） ============
// TSF compartment 读写通过 PowerShell COM 互操作实现（见 queryTSFMode/setTSFMode）
// koffi 原生 COM 支持需要更复杂的 vtable 映射，暂用 PowerShell 作为可靠替代

// ============ 懒加载（避免非 Windows 平台加载 koffi） ============

let initialized = false;
let _CoInitializeEx: any;
let _CoCreateInstance: any;

function ensureLoaded() {
    if (initialized) return;
    initialized = true;
    _CoInitializeEx = CoInitializeEx;
    _CoCreateInstance = CoCreateInstance;
}

// ============ 持久化 PowerShell 管道（快速路径） ============

type LogSink = {
    info: (message: string) => void;
    error: (message: string) => void;
};

let _pipe: TSFPipe | null = null;

function getPipe(logger?: LogSink): TSFPipe {
    if (!_pipe) {
        _pipe = new TSFPipe(logger || { info: () => {}, error: () => {} });
    }
    return _pipe;
}

/**
 * 通过持久化 PowerShell 管道查询 TSF 模式（异步，~2-5ms）
 * 返回 'zh' | 'en' | null
 */
export async function queryTSFModeAsync(logger?: LogSink): Promise<'zh' | 'en' | null> {
    try {
        const pipe = getPipe(logger);
        await pipe.initialize();
        return await pipe.queryMode();
    } catch {
        return null;
    }
}

/**
 * 通过持久化 PowerShell 管道设置 TSF 模式（异步，~2-5ms）
 * 返回是否成功
 */
export async function setTSFModeAsync(chinese: boolean, logger?: LogSink): Promise<boolean> {
    try {
        const pipe = getPipe(logger);
        await pipe.initialize();
        return await pipe.setMode(chinese);
    } catch {
        return false;
    }
}

/**
 * 释放持久化 PowerShell 管道
 */
export function disposeTSFPipe(): void {
    if (_pipe) {
        _pipe.dispose();
        _pipe = null;
    }
}

// ============ 公共 API（同步回退） ============

/**
 * 检测当前系统是否有 TSF 输入法管理器
 */
export function detectTSF(): boolean {
    ensureLoaded();

    const hr = _CoInitializeEx(null, COINIT_APARTMENTTHREADED);
    if (hr !== 0 && hr !== 1 && hr !== -2147417850) return false;

    try {
        const pUnk = [null];
        const hr2 = _CoCreateInstance(
            CLSID_TF_ThreadMgr, null, CLSCTX_INPROC_SERVER,
            IID_ITfThreadMgr, pUnk
        );
        if (hr2 !== 0 || !pUnk[0]) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * 通过 TSF compartment 读取输入法模式
 * 返回 'zh' | 'en'，失败返回 null（调用方应降级到 IMM32）
 */
export function queryTSFMode(): 'zh' | 'en' | null {
    ensureLoaded();

    // 尝试通过 PowerShell COM 访问 TSF compartment（最可靠的方式）
    // PowerShell 的 COM 互操作比 koffi 更稳定
    try {
        const { execFileSync } = require('child_process');
        const script = `
$tsf = New-Object -ComObject MsTf.TF_ThreadMgr
if ($tsf) {
    try {
        $tsf.Activate([ref]0)
        $docMgr = $tsf.GetFocus()
        if ($docMgr) {
            $compMgr = $docMgr -as [Msctf.ITfCompartmentMgr]
            if ($compMgr) {
                $comp = $compMgr.GetCompartment([Guid]'58273AAD-01BB-4164-95C6-755BA0B5162D')
                if ($comp) {
                    $val = $comp.GetValue()
                    Write-Output "mode:$val"
                }
            }
        }
        $tsf.Deactivate()
    } catch {
        Write-Output "error:$_"
    }
}`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const result = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
            encoding: 'utf-8',
            timeout: 2000
        }).trim();

        const modeMatch = result.match(/mode:(\d+)/);
        if (modeMatch) {
            return parseInt(modeMatch[1], 10) !== 0 ? 'zh' : 'en';
        }
    } catch {
        // PowerShell 失败，降级
    }

    return null;
}

/**
 * 通过 TSF compartment 设置输入法模式
 * chinese: true=中文, false=英文
 * 返回是否成功
 */
export function setTSFMode(chinese: boolean): boolean {
    ensureLoaded();

    try {
        const { execFileSync } = require('child_process');
        const val = chinese ? 1 : 0;
        const script = `
$tsf = New-Object -ComObject MsTf.TF_ThreadMgr
if ($tsf) {
    try {
        $tsf.Activate([ref]0)
        $docMgr = $tsf.GetFocus()
        if ($docMgr) {
            $compMgr = $docMgr -as [Msctf.ITfCompartmentMgr]
            if ($compMgr) {
                $comp = $compMgr.GetCompartment([Guid]'58273AAD-01BB-4164-95C6-755BA0B5162D')
                if ($comp) {
                    $comp.SetValue(${val})
                    Write-Output "ok"
                }
            }
        }
        $tsf.Deactivate()
    } catch {
        Write-Output "error:$_"
    }
}`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const result = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
            encoding: 'utf-8',
            timeout: 2000
        }).trim();

        return result.includes('ok');
    } catch {
        return false;
    }
}
