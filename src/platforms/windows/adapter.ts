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
import { IPlatformAdapter, SwitchResult, ExternalSwitchSource } from '../../core/types';
import { ValuePoller } from '../../core/poller';
import { LogSink } from '../../infra/logger';
import * as ffi from '../../win32/ime-ffi';
import { DualKeyboardStrategy } from './dual-keyboard';
import { SingleKeyboardStrategy } from './single-keyboard';

type WindowsStrategy = DualKeyboardStrategy | SingleKeyboardStrategy;
type StrategyKind = 'auto' | 'dual-keyboard' | 'single-keyboard';

/** auto-ime.windows.pollingInterval 未配置/非法时使用的默认轮询间隔 */
const DEFAULT_POLLING_INTERVAL_MS = 150;

export class WindowsAdapter implements IPlatformAdapter {
    readonly name = 'windows';
    private logger!: LogSink;
    private strategy: WindowsStrategy | null = null;
    private poller: ValuePoller<'zh' | 'en'> | null = null;

    init(logger: LogSink): void {
        this.logger = logger;
        logger.info('[Windows] Platform detected');

        // Enumerate keyboard layouts
        const { enLangId, zhLangId } = ffi.enumerateKeyboardLayouts(logger);
        logger.info(`[Windows] Keyboard layouts: en=${enLangId} (0x${enLangId.toString(16)}), zh=${zhLangId} (0x${zhLangId.toString(16)})`);

        const canDual = !!enLangId && !!zhLangId;
        const canSingle = !!zhLangId;
        const configured = this.readStrategyConfig();

        if (configured === 'single-keyboard') {
            if (!canSingle) {
                logger.error('[Windows] strategy=single-keyboard configured but no Chinese keyboard layout found');
                return;
            }
            this.useSingle();
            return;
        }

        if (configured === 'dual-keyboard' && !canDual) {
            if (!canSingle) {
                logger.error('[Windows] strategy=dual-keyboard configured but no usable keyboard layouts found');
                return;
            }
            logger.error('[Windows] strategy=dual-keyboard configured but English keyboard layout missing — falling back to single-keyboard toggle');
            this.useSingle();
            return;
        }

        // auto, or an explicitly configured strategy that the system can satisfy
        if (canDual) {
            this.useDual(enLangId, zhLangId, logger);
        } else if (canSingle) {
            this.useSingle();
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
        this.strategy?.syncState?.();
    }

    /**
     * Observe external (manual) switches.
     *
     * - dual keyboard: the foreground thread's Language ID is readable, so an
     *   Alt+Shift switch IS detectable — poll the layout (interval comes from
     *   `auto-ime.windows.pollingInterval`).
     * - single keyboard: for a TSF-only app (VS Code / Electron) there is no
     *   reliable cross-process read of the IME open/close state, so external
     *   switches are simply not observable; state stays internally tracked.
     */
    async startListening(onChange: (mode: 'zh' | 'en') => void): Promise<ExternalSwitchSource> {
        if (!this.strategy) return 'not-observable';
        if (!this.strategy.observesExternalSwitches) {
            this.logger.info('[Windows] External switches not observable (single-keyboard TSF IME)');
            return 'not-observable';
        }

        const intervalMs = this.readPollingIntervalConfig();
        this.logger.info(`[Windows] Polling Language ID for external switches (${intervalMs}ms)`);
        this.poller = new ValuePoller<'zh' | 'en'>(
            () => this.queryMode(),
            (mode) => onChange(mode),
            () => intervalMs,
        );
        this.poller.start();
        return 'adapter-polling';
    }

    stopListening(): void {
        if (!this.poller) return;
        this.poller.stop();
        this.poller = null;
    }

    /**
     * 失焦暂停轮询。单次 GetKeyboardLayout 很廉价，但没有焦点时读到也不会触发任何动作，
     * 持续轮询只是把开销挂在一个对用户无意义的状态上。
     */
    setObserving(observing: boolean): void {
        if (!this.poller) return;
        if (observing) {
            this.poller.resume();
        } else {
            this.poller.pause();
        }
    }

    dispose(): void {
        this.stopListening();
        this.strategy = null;
    }

    // ============ Private ============

    /** 读取 auto-ime.windows 下的枚举配置；非法值回退并告警 */
    private readEnumConfig(key: string, allowed: readonly string[], fallback: string): string {
        let value: unknown;
        try {
            value = vscode.workspace.getConfiguration('auto-ime.windows').get<string>(key, fallback);
        } catch (e) {
            this.logger.warn(`[Windows] Failed to read ${key} config: ${e}`);
            return fallback;
        }
        if (allowed.includes(String(value))) return String(value);
        this.logger.warn(`[Windows] Unknown ${key} '${String(value)}', falling back to '${fallback}'`);
        return fallback;
    }

    private readStrategyConfig(): StrategyKind {
        return this.readEnumConfig('strategy', ['auto', 'dual-keyboard', 'single-keyboard'], 'auto') as StrategyKind;
    }

    private readToggleKeyConfig(): 'shift' | 'ctrl-space' {
        return this.readEnumConfig('toggleKey', ['shift', 'ctrl-space'], 'shift') as 'shift' | 'ctrl-space';
    }

    private readPollingIntervalConfig(): number {
        try {
            const value = vscode.workspace
                .getConfiguration('auto-ime.windows')
                .get<number>('pollingInterval', DEFAULT_POLLING_INTERVAL_MS);
            if (typeof value === 'number' && value > 0) return value;
            this.logger.warn(`[Windows] Invalid pollingInterval ${value}, using ${DEFAULT_POLLING_INTERVAL_MS}ms`);
        } catch (e) {
            this.logger.warn(`[Windows] Failed to read pollingInterval config: ${e}`);
        }
        return DEFAULT_POLLING_INTERVAL_MS;
    }

    private useDual(enLangId: number, zhLangId: number, logger: LogSink): void {
        this.strategy = new DualKeyboardStrategy(enLangId, zhLangId, logger);
        logger.info(`[Windows] Strategy: dual-keyboard (en=${enLangId}, zh=${zhLangId})`);
    }

    private useSingle(): void {
        const toggleKey = this.readToggleKeyConfig();
        this.strategy = new SingleKeyboardStrategy(this.logger, toggleKey);
        this.logger.info(`[Windows] Strategy: single-keyboard toggle (${toggleKey})`);
    }
}
