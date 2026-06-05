/**
 * Core type definitions for Auto IME
 * Platform-agnostic interfaces that decouple analysis from switching
 */

import * as vscode from 'vscode';
import { LogSink } from '../logger';

// ========== Platform Adapter ==========

/**
 * Platform-specific IME adapter
 * Implementations: LinuxAdapter (Fcitx5/4/IBus), WindowsAdapter (dual/single keyboard)
 */
export interface IPlatformAdapter {
    /** Platform name for logging */
    readonly name: string;

    /** Initialize (enumerate keyboards, detect TSF, etc.) */
    init(logger: LogSink): void;

    /** Is ready (both en and zh keyboards available) */
    isReady(): boolean;

    /** Query current IME mode */
    queryMode(): 'zh' | 'en';

    /** Switch to English */
    switchToEnglish(): SwitchResult;

    /** Switch to Chinese */
    switchToChinese(): SwitchResult;

    /** Sync internal state with system state (after manual switch) */
    syncState?(): void;

    /** Start event-driven listening for external manual switches (D-Bus signals, etc.) */
    startListening?(callback: (mode: 'zh' | 'en') => void): Promise<void>;

    /** Release resources */
    dispose?(): void;
}

export type SwitchResult = {
    success: boolean;
    method: string;  // 'layout' | 'imm32' | 'tsf' | 'fcitx5' | 'ibus' | 'skip' | 'none'
    elapsedMs?: number;
};

// ========== Mode Listener ==========

/**
 * Mode-specific event listener
 * Implementations: NormalModeListener, VimModeListener
 */
export interface IModeListener {
    /** Mode name for logging */
    readonly name: string;

    /** Register event listeners, return disposables */
    register(ctx: ModeContext): vscode.Disposable[];

    /** Release resources */
    dispose?(): void;
}

/**
 * Context provided to mode listeners
 * Listeners use this to communicate with the controller
 */
export interface ModeContext {
    /** Analyze cursor context and switch IME if needed */
    analyzeAndSwitch(editor: vscode.TextEditor): Promise<void>;

    /** Force switch to English (ESC in Vim) */
    forceEnglish(): void;

    /** Toggle IME (user manual trigger) */
    toggleIME(): void;

    /** Update status bar display */
    updateStatusBar(mode: 'en' | 'zh'): void;

    /** Logger */
    logger: LogSink;
}

// ========== Analysis ==========

export type CursorContext = 'comment' | 'string' | 'code';

export type AnalysisResult = {
    context: CursorContext;
    /** Whether a switch should happen */
    shouldSwitch: boolean;
    /** Target mode, null means no switch needed */
    targetMode: 'zh' | 'en' | null;
};
