/**
 * Windows Platform Adapter
 * Auto-detects keyboard layout and selects strategy:
 * - Dual keyboard: English(1033) + Chinese(2052) → layout switching
 * - Single keyboard: only Chinese(2052) → TSF compartment (future)
 */

import { IPlatformAdapter, SwitchResult } from '../../core/types';
import { LogSink } from '../../logger';
import * as ffi from '../../win32/ime-ffi';
import { DualKeyboardStrategy } from './dual-keyboard';

export class WindowsAdapter implements IPlatformAdapter {
    readonly name = 'windows';
    private logger!: LogSink;
    private strategy: DualKeyboardStrategy | null = null;

    init(logger: LogSink): void {
        this.logger = logger;
        logger.info('[Windows] Platform detected');

        // Enumerate keyboard layouts
        const { enLangId, zhLangId } = ffi.enumerateKeyboardLayouts(logger);
        logger.info(`[Windows] Keyboard layouts: en=${enLangId} (0x${enLangId.toString(16)}), zh=${zhLangId} (0x${zhLangId.toString(16)})`);

        if (enLangId && zhLangId) {
            // Dual keyboard: English + Chinese
            this.strategy = new DualKeyboardStrategy(ffi, enLangId, zhLangId, logger);
            logger.info(`[Windows] Strategy: dual-keyboard (en=${enLangId}, zh=${zhLangId})`);
        } else if (zhLangId) {
            // Single keyboard: only Chinese (future: TSF compartment)
            logger.warn('[Windows] Single keyboard detected — TSF compartment not yet implemented');
            // TODO: this.strategy = new SingleKeyboardStrategy(...)
        } else {
            logger.error('[Windows] No Chinese keyboard layout found');
        }
    }

    isReady(): boolean {
        return this.strategy !== null;
    }

    queryMode(): 'zh' | 'en' {
        if (!this.strategy) return 'en';
        return this.strategy.queryMode();
    }

    switchToEnglish(): SwitchResult {
        if (!this.strategy) return { success: false, method: 'none' };
        return this.strategy.switchToEnglish();
    }

    switchToChinese(): SwitchResult {
        if (!this.strategy) return { success: false, method: 'none' };
        return this.strategy.switchToChinese();
    }

    syncState(): void {
        if (this.strategy?.syncState) {
            this.strategy.syncState();
        }
    }

    dispose(): void {
        // nothing to clean up
    }
}
