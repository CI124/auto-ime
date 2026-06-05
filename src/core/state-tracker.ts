/**
 * IME State Tracker
 * Tracks current IME mode, detects manual vs auto switches, manages override state
 *
 * Event-driven architecture:
 * - Linux: D-Bus signals (Fcitx5 InputMethodChanged / IBus GlobalEngineChanged)
 * - Windows: polling (no D-Bus available)
 *
 * No suppress window needed:
 * - controller.switchTo() updates adapter internal state BEFORE notifyAutoSwitch()
 * - poll/adapter.queryMode() and currentIME are always in sync
 * - only external switches (system tray) cause detectable changes
 */

import { IPlatformAdapter } from './types';
import { LogSink } from '../logger';

export class IMEStateTracker {
    private logger: LogSink;
    private adapter: IPlatformAdapter;
    private manualOverride = false;
    private currentIME = '';
    private lastPositionLine = -1;
    private lastPositionChar = -1;
    private pollingTimer: NodeJS.Timeout | null = null;
    private onChangeCallback: ((newIME: string) => void) | null = null;
    private usePolling = false;

    constructor(adapter: IPlatformAdapter, logger: LogSink) {
        this.adapter = adapter;
        this.logger = logger;
    }

    /**
     * Start listening for IME state changes
     * Linux: D-Bus signal (event-driven, no polling)
     * Windows: polling (500ms)
     */
    async startListening(intervalMs?: number): Promise<void> {
        this.currentIME = this.adapter.queryMode();
        this.logger.info(`[StateTracker] Initial IME: ${this.currentIME}`);

        // Try event-driven listening (D-Bus on Linux)
        if (this.adapter.startListening) {
            const connected = await this.tryStartEventListening();
            if (connected) {
                this.logger.info('[StateTracker] Event-driven listening active (D-Bus)');
                return;
            }
        }

        // Fallback to polling (Windows, or D-Bus unavailable)
        this.usePolling = true;
        const interval = intervalMs || 500;
        this.startPolling(interval);
        this.logger.info(`[StateTracker] Polling started (${interval}ms)`);
    }

    /**
     * Stop listening
     */
    stopListening(): void {
        this.logger.info('[StateTracker] Stopping');
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
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
        if (this.currentIME !== mode) {
            this.currentIME = mode;
        }
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
     * Record current cursor position
     */
    updatePosition(line: number, character: number): void {
        this.lastPositionLine = line;
        this.lastPositionChar = character;
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
     * Try to start event-driven listening via adapter
     */
    private async tryStartEventListening(): Promise<boolean> {
        try {
            await this.adapter.startListening!((newIME: 'zh' | 'en') => {
                this.handleExternalSwitch(newIME);
            });
            return true;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.info(`[StateTracker] Event listening failed: ${msg}`);
            return false;
        }
    }

    /**
     * Handle external switch detected by D-Bus signal or polling
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

    /**
     * Polling fallback (Windows only)
     */
    private startPolling(intervalMs: number): void {
        this.pollingTimer = setInterval(() => {
            const newIME = this.adapter.queryMode();
            if (newIME && newIME !== this.currentIME) {
                this.handleExternalSwitch(newIME);
            }
        }, intervalMs);
    }
}
