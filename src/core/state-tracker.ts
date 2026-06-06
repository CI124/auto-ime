/**
 * IME State Tracker
 * Tracks current IME mode, detects manual vs auto switches, manages override state
 *
 * State tracking strategy:
 * - Linux: Adaptive polling via LinuxAdapter (100ms active, 500ms idle)
 * - Windows: Polling via WindowsAdapter (configurable interval)
 * - Both platforms use polling for reliable external switch detection
 *
 * Why polling instead of D-Bus signals?
 * - Fcitx5 does NOT emit InputContext signals for remote switching (fcitx5-remote)
 * - dbus-monitor testing showed only method calls, no signals
 * - Async polling is reliable and non-blocking
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

    constructor(adapter: IPlatformAdapter, logger: LogSink) {
        this.adapter = adapter;
        this.logger = logger;
    }

    /**
     * Start listening for IME state changes
     * 
     * Strategy:
     * 1. Call adapter.startListening() which handles platform-specific polling
     * 2. Start a low-frequency fallback polling as safety net
     * 
     * The adapter's startListening() returns:
     * - false: adapter handles its own polling (Linux adaptive, Windows interval)
     * - true: event-driven mode (currently unused, reserved for future)
     */
    async startListening(intervalMs?: number): Promise<void> {
        this.currentIME = this.adapter.queryMode();
        this.logger.info(`[StateTracker] Initial IME: ${this.currentIME}`);

        // Start adapter's platform-specific listening
        if (this.adapter.startListening) {
            try {
                const eventDriven = await this.adapter.startListening((newIME: 'zh' | 'en') => {
                    this.handleExternalSwitch(newIME);
                });
                
                if (eventDriven) {
                    this.logger.info('[StateTracker] Event-driven listening active');
                } else {
                    this.logger.info('[StateTracker] Adapter handles its own polling');
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                this.logger.warn(`[StateTracker] Adapter startListening failed: ${msg}`);
            }
        }

        // Always start low-frequency fallback polling as safety net
        // This catches edge cases where adapter polling might miss a change
        const fallbackInterval = intervalMs || 2000;
        this.startFallbackPolling(fallbackInterval);
        this.logger.info(`[StateTracker] Fallback polling started (${fallbackInterval}ms)`);
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

    /**
     * Low-frequency fallback polling (safety net)
     * 
     * This runs at a lower frequency than the adapter's own polling
     * to catch any edge cases where the adapter might miss a change.
     * 
     * Linux: adapter uses 100ms/500ms adaptive, this uses 2000ms
     * Windows: adapter uses configurable interval (default 150ms), this uses 2000ms
     */
    private startFallbackPolling(intervalMs: number): void {
        this.pollingTimer = setInterval(() => {
            const newIME = this.adapter.queryMode();
            if (newIME && newIME !== this.currentIME) {
                this.handleExternalSwitch(newIME);
            }
        }, intervalMs);
    }

}
