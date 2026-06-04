/**
 * Dual Keyboard Strategy (Windows)
 * Switches between English(1033) and Chinese(2052) keyboard layouts
 * Uses PostMessageW(WM_INPUTLANGCHANGEREQUEST)
 *
 * Key insight: PostMessageW is async, so we track target layout internally
 * instead of querying system state (which would be stale).
 */

import { SwitchResult } from '../../core/types';
import { LogSink } from '../../logger';
import * as ffi from '../../win32/ime-ffi';

export class DualKeyboardStrategy {
    private enLangId: number;
    private zhLangId: number;
    private logger: LogSink;
    private currentLayout: number; // Internal target state

    constructor(_ffi: typeof ffi, enLangId: number, zhLangId: number, logger: LogSink) {
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

        // Check internal target state (not async system state)
        if (this.currentLayout === this.enLangId) {
            return { success: true, method: 'skip' };
        }

        const t0 = Date.now();
        this.currentLayout = this.enLangId;
        ffi.switchKeyboardLayout(this.enLangId, this.logger);
        this.logger.info(`[DualKB] EN: layout (${Date.now() - t0}ms)`);
        return { success: true, method: 'layout', elapsedMs: Date.now() - t0 };
    }

    switchToChinese(): SwitchResult {
        if (!this.zhLangId) {
            this.logger.error('[DualKB] ZH: no Chinese keyboard layout');
            return { success: false, method: 'none' };
        }

        // Check internal target state
        if (this.currentLayout === this.zhLangId) {
            return { success: true, method: 'skip' };
        }

        const t0 = Date.now();
        this.currentLayout = this.zhLangId;
        ffi.switchKeyboardLayout(this.zhLangId, this.logger);
        this.logger.info(`[DualKB] ZH: layout (${Date.now() - t0}ms)`);
        return { success: true, method: 'layout', elapsedMs: Date.now() - t0 };
    }

    /**
     * Sync internal state with system (call on window focus)
     */
    syncState(): void {
        this.currentLayout = ffi.getCurrentLanguageId();
    }
}
