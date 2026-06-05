/**
 * IME State Tracker
 * Tracks current IME mode, detects manual vs auto switches, manages override state
 * Platform-agnostic: uses IPlatformAdapter for actual state queries
 *
 * Performance optimization (v0.6.1):
 * - Polling interval increased to 500ms (from 150ms) since adapter uses internal state
 * - notifyAutoSwitch() updates currentIME immediately after auto-switch
 * - syncState() calls adapter.syncState() to refresh from system on window focus
 * - Poll only detects external manual switches (user pressing system hotkeys)
 */

import { IPlatformAdapter } from './types';
import { LogSink } from '../logger';

export class IMEStateTracker {
    private logger: LogSink;
    private adapter: IPlatformAdapter;
    private lastAutoSwitchTime = 0;
    private autoSwitchSuppressUntil = 0;
    private manualOverride = false;
    private currentIME = '';
    private lastPositionLine = -1;
    private lastPositionChar = -1;
    private pollingTimer: NodeJS.Timeout | null = null;
    private onChangeCallback: ((newIME: string) => void) | null = null;
    private pollingInterval = 500; // Increased from 150ms — poll is only for external manual switches

    constructor(adapter: IPlatformAdapter, logger: LogSink) {
        this.adapter = adapter;
        this.logger = logger;
    }

    /**
     * Start listening for IME state changes
     */
    startListening(intervalMs?: number): void {
        this.currentIME = this.adapter.queryMode();
        this.logger.info(`[StateTracker] Initial IME: ${this.currentIME}`);

        if (intervalMs) {
            this.pollingInterval = intervalMs;
        }
        this.startPolling();
        this.logger.info(`[StateTracker] Polling started (${this.pollingInterval}ms)`);
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
     * Mark as auto switch (before executing switchToXxx)
     * Sets suppress window to prevent polling from detecting our own switch
     */
    markAutoSwitch(): void {
        this.lastAutoSwitchTime = Date.now();
        this.autoSwitchSuppressUntil = this.lastAutoSwitchTime + 1500;
    }

    /**
     * Notify that an auto-switch was successful
     * Updates currentIME immediately to prevent poll from re-detecting
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
     * Get current IME mode
     */
    getCurrentIME(): string {
        return this.currentIME;
    }

    /**
     * Sync state with system (call on window focus)
     * Refreshes adapter's internal state from actual system state
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

    private startPolling(): void {
        this.pollingTimer = setInterval(() => {
            // Skip query during suppress window
            if (Date.now() < this.autoSwitchSuppressUntil) return;

            const newIME = this.adapter.queryMode();
            if (newIME && newIME !== this.currentIME) {
                this.handleIMEChange(newIME);
            }
        }, this.pollingInterval);
    }

    private handleIMEChange(newIME: string): void {
        if (newIME === this.currentIME) return;

        const oldIME = this.currentIME;
        const now = Date.now();

        // Within suppress window → auto switch, don't trigger manual logic
        if (now < this.autoSwitchSuppressUntil) {
            this.currentIME = newIME;
            const elapsed = now - this.lastAutoSwitchTime;
            this.logger.info(`[StateTracker] Auto switch: ${oldIME} → ${newIME} (${elapsed}ms)`);
            return;
        }

        this.currentIME = newIME;

        // User manual switch
        this.manualOverride = true;
        this.logger.info(`[StateTracker] Manual switch: ${oldIME} → ${newIME}, pausing auto switch`);

        if (this.onChangeCallback) {
            this.onChangeCallback(newIME);
        }
    }
}
