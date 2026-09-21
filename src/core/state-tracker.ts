/**
 * IME State Tracker
 * Tracks current IME mode, detects manual vs auto switches, manages override state
 *
 * Who detects what:
 * - The platform adapter owns the detection of external (manual) switches,
 *   because "how to read the current IME" is a platform detail:
 *   - Linux: adaptive polling (100ms active / 500ms idle) inside LinuxAdapter
 *   - Windows dual keyboard: Language-ID polling inside WindowsAdapter
 *   - Windows single keyboard: not observable (TSF-only host), so no polling at all
 * - This class only consumes the callbacks; it deliberately does NOT run its own
 *   timer, otherwise the same state gets polled twice per interval
 *
 * Why polling instead of D-Bus signals?
 * - Fcitx5 does NOT emit InputContext signals for remote switching (fcitx5-remote)
 * - dbus-monitor testing showed only method calls, no signals
 * - Async polling is reliable and non-blocking
 *
 * No suppress window needed:
 * - controller.switchTo() calls notifyAutoSwitch() synchronously, so currentIME
 *   always equals the mode the controller believes the system is in
 * - adapter.queryMode() reads the adapter's own tracked target state, so it stays
 *   consistent with currentIME without any extra suppression
 * - only external switches (system tray / hotkey) cause a detectable difference
 */

import { ExternalSwitchSource, IPlatformAdapter } from './types';
import { LogSink } from '../infra/logger';

export class IMEStateTracker {
    private logger: LogSink;
    private adapter: IPlatformAdapter;
    private manualOverride = false;
    private currentIME = '';
    private lastPositionLine = -1;
    private onChangeCallback: ((newIME: string) => void) | null = null;

    constructor(adapter: IPlatformAdapter, logger: LogSink) {
        this.adapter = adapter;
        this.logger = logger;
    }

    /**
     * Start listening for IME state changes
     *
     * Delegates to the adapter, which owns the detection mechanism. The returned
     * source is used for logging only — no second poll is started here.
     */
    async startListening(): Promise<ExternalSwitchSource> {
        this.currentIME = this.adapter.queryMode();
        this.logger.info(`[StateTracker] Initial IME: ${this.currentIME}`);

        if (!this.adapter.startListening) return 'not-observable';

        try {
            const source = await this.adapter.startListening((newIME: 'zh' | 'en') => {
                this.handleExternalSwitch(newIME);
            });
            this.logger.info(
                source === 'adapter-polling'
                    ? '[StateTracker] Adapter polls external switches; no extra polling here'
                    : `[StateTracker] External switches not observable on this platform (${source})`
            );
            return source;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`[StateTracker] Adapter startListening failed: ${msg}`);
            return 'not-observable';
        }
    }

    /**
     * Stop listening (the adapter owns the only timer)
     */
    stopListening(): void {
        this.logger.info('[StateTracker] Stopping');
        this.adapter.stopListening?.();
    }

    /**
     * Set callback for manual switch detection
     */
    setOnChangeCallback(callback: (newIME: string) => void): void {
        this.onChangeCallback = callback;
    }

    /**
     * Notify that a switch was performed by the controller
     * Updates currentIME immediately to prevent poll/event re-detection
     */
    notifyAutoSwitch(mode: 'zh' | 'en'): void {
        this.currentIME = mode;
    }

    /**
     * Is in manual override mode
     */
    isManualOverride(): boolean {
        return this.manualOverride;
    }

    /**
     * Reset manual override (ESC or cursor moves to new line)
     */
    resetManualOverride(): void {
        this.manualOverride = false;
    }

    /**
     * Mark as manual switch (user toggled via status bar)
     */
    markManualSwitch(): void {
        this.manualOverride = true;
    }

    /**
     * Check if cursor moved to a different line
     */
    isDifferentPosition(line: number): boolean {
        return line !== this.lastPositionLine;
    }

    /**
     * Record current cursor line (used by isDifferentPosition)
     */
    updatePosition(line: number): void {
        this.lastPositionLine = line;
    }

    /**
     * Sync state with system (call on window focus)
     */
    syncState(): void {
        if (this.adapter.syncState) {
            this.adapter.syncState();
        }
        const newIME = this.adapter.queryMode();
        if (newIME && newIME !== this.currentIME) {
            this.logger.info(`[StateTracker] Sync: ${this.currentIME} → ${newIME}`);
            this.currentIME = newIME;
        }
    }

    // ========== Private ==========

    /**
     * Handle external switch detected by polling or adapter callback
     */
    private handleExternalSwitch(newIME: string): void {
        if (newIME === this.currentIME) return;

        const oldIME = this.currentIME;
        this.currentIME = newIME;
        this.manualOverride = true;

        // Sync adapter internal state so queryMode() returns the correct value
        if (this.adapter.syncState) {
            this.adapter.syncState();
        }

        this.logger.info(`[StateTracker] External switch: ${oldIME} → ${newIME}, pausing auto`);

        if (this.onChangeCallback) {
            this.onChangeCallback(newIME);
        }
    }
}
