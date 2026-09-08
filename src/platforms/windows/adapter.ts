/**
 * Windows Platform Adapter
 * Auto-detects keyboard layout and selects strategy:
 * - Dual keyboard: English(1033) + Chinese(2052) → layout switching (default)
 * - Single keyboard: only Chinese(2052) → IME toggle hotkey (Shift / Ctrl+Space)
 *
 * Strategy can be forced with `auto-ime.windows.strategy`:
 *   auto (default) | dual-keyboard | single-keyboard
 */

import * as vscode from 'vscode';
import { IPlatformAdapter, SwitchResult } from '../../core/types';
import { LogSink } from '../../logger';
import * as ffi from '../../win32/ime-ffi';
import { DualKeyboardStrategy } from './dual-keyboard';
import { SingleKeyboardStrategy } from './single-keyboard';

type WindowsStrategy = DualKeyboardStrategy | SingleKeyboardStrategy;

export class WindowsAdapter implements IPlatformAdapter {
    readonly name = 'windows';
    private logger!: LogSink;
    private strategy: WindowsStrategy | null = null;

    init(logger: LogSink): void {
        this.logger = logger;
        logger.info('[Windows] Platform detected');

        // Enumerate keyboard layouts
        const { enLangId, zhLangId } = ffi.enumerateKeyboardLayouts(logger);
        logger.info(`[Windows] Keyboard layouts: en=${enLangId} (0x${enLangId.toString(16)}), zh=${zhLangId} (0x${zhLangId.toString(16)})`);

        const configured = this.readStrategyConfig();
        const canDual = !!enLangId && !!zhLangId;
        const canSingle = !!zhLangId;

        if (configured === 'single-keyboard') {
            if (canSingle) {
                this.useSingle();
            } else {
                logger.error('[Windows] strategy=single-keyboard configured but no Chinese keyboard layout found');
            }
        } else if (configured === 'dual-keyboard') {
            if (canDual) {
                this.useDual(ffi, enLangId, zhLangId, logger);
            } else if (canSingle) {
                logger.error('[Windows] strategy=dual-keyboard configured but English keyboard layout missing — falling back to single-keyboard toggle');
                this.useSingle();
            } else {
                logger.error('[Windows] strategy=dual-keyboard configured but no usable keyboard layouts found');
            }
        } else {
            // auto
            if (canDual) {
                this.useDual(ffi, enLangId, zhLangId, logger);
            } else if (canSingle) {
                this.useSingle();
            } else {
                logger.error('[Windows] No Chinese keyboard layout found');
            }
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
        this.strategy?.syncState?.();
    }

    /**
     * No event-driven listening: for a TSF-only app there is no reliable
     * cross-process read of the IME open/close state, so manual switches are
     * not observable. The state tracker's polling fallback still runs (it reads
     * our own tracked state via queryMode()).
     */
    async startListening(_callback: (mode: 'zh' | 'en') => void): Promise<boolean> {
        return false;
    }

    dispose(): void {
        this.strategy = null;
    }

    // ============ Private ============

    private readStrategyConfig(): 'auto' | 'dual-keyboard' | 'single-keyboard' {
        try {
            const value = vscode.workspace
                .getConfiguration('auto-ime.windows')
                .get<string>('strategy', 'auto');
            if (value === 'dual-keyboard' || value === 'single-keyboard') return value;
            if (value !== 'auto') {
                this.logger.warn(`[Windows] Unknown strategy '${value}', falling back to auto`);
            }
        } catch (e) {
            this.logger.warn(`[Windows] Failed to read strategy config: ${e}`);
        }
        return 'auto';
    }

    private readToggleKeyConfig(): 'shift' | 'ctrl-space' {
        try {
            const value = vscode.workspace
                .getConfiguration('auto-ime.windows')
                .get<string>('toggleKey', 'shift');
            if (value === 'ctrl-space') return value;
            if (value !== 'shift') {
                this.logger.warn(`[Windows] Unknown toggleKey '${value}', using shift`);
            }
        } catch (e) {
            this.logger.warn(`[Windows] Failed to read toggleKey config: ${e}`);
        }
        return 'shift';
    }

    private useDual(
        ffiModule: typeof ffi,
        enLangId: number,
        zhLangId: number,
        logger: LogSink
    ): void {
        this.strategy = new DualKeyboardStrategy(ffiModule, enLangId, zhLangId, logger);
        logger.info(`[Windows] Strategy: dual-keyboard (en=${enLangId}, zh=${zhLangId})`);
    }

    private useSingle(): void {
        const toggleKey = this.readToggleKeyConfig();
        this.strategy = new SingleKeyboardStrategy(this.logger, toggleKey);
        this.logger.info(`[Windows] Strategy: single-keyboard toggle (${toggleKey})`);
    }
}
