/**
 * Core type definitions for Auto IME
 * Platform-agnostic interfaces that decouple analysis from switching
 */

import * as vscode from 'vscode';
import { LogSink } from '../infra/logger';

// ========== Platform Adapter ==========

/**
 * Platform-specific IME adapter
 * Implementations: LinuxAdapter (Fcitx5/IBus), WindowsAdapter (dual/single keyboard)
 */
export interface IPlatformAdapter {
    /** Platform name for logging */
    readonly name: string;

    /** Initialize (detect IME framework / enumerate keyboard layouts) */
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

    /**
     * Start observing external (manual) IME switches made outside the editor.
     * The adapter owns the detection mechanism; the returned value only says
     * *whether* external switches are observable at all, so upper layers do not
     * start a redundant second poll.
     */
    startListening?(callback: (mode: 'zh' | 'en') => void): Promise<ExternalSwitchSource>;

    /** Stop observing external switches */
    stopListening?(): void;

    /** Release resources */
    dispose?(): void;
}

/**
 * How an adapter learns about external IME switches:
 * - 'adapter-polling'  adapter polls its own probe and calls back on change
 * - 'event-driven'     OS event source drives the callback (currently unused)
 * - 'not-observable'   no reliable read-back exists, external switches cannot be seen
 */
export type ExternalSwitchSource = 'adapter-polling' | 'event-driven' | 'not-observable';

// ========== Code Context Analyzer ==========

/**
 * 游标语义分析器：判断光标是否位于注释/字符串中，供 controller 决定是否切换输入法。
 * controller 只依赖此接口而非具体的 ASTAnalyzer，使核心层与 tree-sitter 实现解耦、可测。
 * 实现：ASTAnalyzer（web-tree-sitter + 快速文本启发式）。
 */
export interface IAnalyzer {
    /** 初始化（加载 tree-sitter 运行时）；扩展激活时调用一次 */
    init(): void | Promise<void>;

    /**
     * 对该 languageId 是否有【可靠的判定能力】（已登记 wasm 与 query）。
     *
     * 为什么需要单独一个方法：isCursorInCommentOrString 对未知语言只能返回
     * { match: false }，而 false 在调用方看来与“确认是代码”无法区分。没有这个信号，
     * markdown / plaintext 里写中文会被当成代码抢切回英文。所以上层先用本方法
     * 判断“要不要管”，再把 false 当作真正的“不是注释/字符串”。
     */
    supports(languageId: string): boolean;

    /**
     * 快速文本级注释检测（同步，无 AST 开销）
     * @returns true=确定在注释中, false=确定不在, null=不确定，需 AST
     */
    isCursorInCommentFast(
        document: vscode.TextDocument,
        position: vscode.Position,
        languageId: string,
    ): boolean | null;

    /** 完整 AST 检测：光标是否在注释或字符串中 */
    isCursorInCommentOrString(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<{ match: boolean; type: string | null }>;

    /** 释放资源 */
    dispose(): void;
}

export type SwitchResult = {
    success: boolean;
    /**
     * 'layout'      keyboard layout switch (Windows dual keyboard)
     * 'toggle'      IME toggle hotkey (Windows single keyboard) — a *flip*, not
     *               an absolute set, because the IME state is thread-scoped and
     *               cannot be read/written cross-process
     * 'fcitx5' | 'ibus'  Linux frameworks
     * 'skip'        already in the requested mode, no work done
     * 'none'        no strategy available
     */
    method: string;
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
