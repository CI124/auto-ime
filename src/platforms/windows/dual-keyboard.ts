/**
 * Dual Keyboard Strategy (Windows)
 * Switches between English(1033) and Chinese(2052) keyboard layouts
 * Uses PostMessageW(WM_INPUTLANGCHANGEREQUEST)
 *
 * Key insight: PostMessageW is async, so we track target layout internally
 * instead of querying system state (which would be stale).
 */

import { SwitchResult } from '../../core/types';
import { LogSink } from '../../infra/logger';
import * as ffi from '../../win32/ime-ffi';

export class DualKeyboardStrategy {
    /** 前台线程的 Language ID 可跨进程读取，因此能轮询到外部（Alt+Shift）切换 */
    readonly observesExternalSwitches = true;

    private enLangId: number;
    private zhLangId: number;
    private logger: LogSink;
    private currentLayout: number; // Internal target state

    constructor(enLangId: number, zhLangId: number, logger: LogSink) {
        this.enLangId = enLangId;
        this.zhLangId = zhLangId;
        this.logger = logger;
        // Initialize from system state
        this.currentLayout = ffi.getCurrentLanguageId();
    }

    queryMode(): 'zh' | 'en' {
        const langId = ffi.getCurrentLanguageId();
        if (ffi.isChineseLangId(langId)) return 'zh';
        return 'en';
    }

    switchToEnglish(): SwitchResult {
        if (!this.enLangId) {
            this.logger.error('[DualKB] EN: no English keyboard layout');
            return { success: false, method: 'none' };
        }
        return this.apply(this.enLangId, 'EN');
    }

    switchToChinese(): SwitchResult {
        if (!this.zhLangId) {
            this.logger.error('[DualKB] ZH: no Chinese keyboard layout');
            return { success: false, method: 'none' };
        }
        return this.apply(this.zhLangId, 'ZH');
    }

    /**
     * 切换到目标键盘布局。PostMessageW 是异步的，因此以内部目标状态判断是否 skip，
     * 而不是读取可能滞后的系统状态。en/zh 两条路径仅目标 LangID 与日志标签不同。
     */
    private apply(langId: number, label: 'EN' | 'ZH'): SwitchResult {
        // Check internal target state (not async system state)
        if (this.currentLayout === langId) {
            return { success: true, method: 'skip' };
        }

        const t0 = Date.now();
        this.currentLayout = langId;
        ffi.switchKeyboardLayout(langId, this.logger);
        this.logger.info(`[DualKB] ${label}: layout (${Date.now() - t0}ms)`);
        return { success: true, method: 'layout', elapsedMs: Date.now() - t0 };
    }

    /**
     * Sync internal state with system (call on window focus)
     */
    syncState(): void {
        this.currentLayout = ffi.getCurrentLanguageId();
    }
}
