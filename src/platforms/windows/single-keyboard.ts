/**
 * Single Keyboard Strategy (Windows)
 *
 * Switches Chinese/English *inside* one IME when no English keyboard layout is
 * installed (or when the user forces it via `auto-ime.windows.strategy`).
 *
 * HOW IT ACTUALLY WORKS (verified on Windows 11 26200):
 * ------------------------------------------------------------------
 * The original plan was to write TSF compartment
 * `GUID_COMPARTMENT_KEYBOARD_OPENCLOSE` from the extension host. That does NOT
 * work: the IME open/close state is *thread/application-scoped*, and the
 * extension host is a separate process from the editor renderer where text
 * input happens. Writing the compartment from another process changes the
 * value but the focused app's IME ignores it (empirically confirmed — typed
 * text still composes Chinese after writing "0").
 *
 * For TSF-only apps (VS Code / Electron) `ImmGetContext` returns 0, so IMM32
 * can neither read nor write the state either.
 *
 * The only reliable cross-process way to flip 中/英 is to let the IME flip
 * itself: inject the IME's own toggle hotkey (Shift, or Ctrl+Space) into the
 * focused window via keybd_event. Verified both directions (zh→en→zh).
 *
 * TRADE-OFFS (honest):
 *   - It is a *toggle*, not an absolute set. We track the target state
 *     internally (`targetMode`) and only toggle when it differs.
 *   - There is no reliable cross-process READ, so a manual switch the user
 *     makes with the mouse/keyboard can drift from our tracked state.
 */
import { SwitchResult } from '../../core/types';
import { LogSink } from '../../logger';
import { sendImeToggle, ToggleKey } from '../../win32/ime-ffi';

export class SingleKeyboardStrategy {
    private logger: LogSink;
    private toggleKey: ToggleKey;
    private targetMode: 'zh' | 'en' | null = null;

    constructor(logger: LogSink, toggleKey: ToggleKey = 'shift') {
        this.logger = logger;
        this.toggleKey = toggleKey;
    }

    /**
     * The toggle is available synchronously (a Chinese layout exists), so the
     * strategy is immediately usable. There is no async pipe to warm up.
     */
    isAvailable(): boolean {
        return true;
    }

    queryMode(): 'zh' | 'en' {
        return this.targetMode ?? 'en';
    }

    switchToEnglish(): SwitchResult {
        return this.apply('en');
    }

    switchToChinese(): SwitchResult {
        return this.apply('zh');
    }

    /**
     * No-op: there is no reliable cross-process read for a TSF-only app, so we
     * cannot observe manual user switches. State remains tracked internally.
     */
    syncState(): void {
        this.logger.debug('[SingleKB] syncState: no cross-process read available, state stays tracked');
    }

    // ============ Private ============

    private apply(mode: 'zh' | 'en'): SwitchResult {
        if (this.targetMode === mode) {
            return { success: true, method: 'skip' };
        }

        const t0 = Date.now();
        try {
            sendImeToggle(this.toggleKey, this.logger);
        } catch (e) {
            // Never throw into the cursor-move hot path (debounce 10-60ms).
            this.logger.error(`[SingleKB] toggle failed: ${e}`);
            return { success: false, method: 'none', elapsedMs: Date.now() - t0 };
        }

        // Optimistically track the requested state. The toggle is injected
        // synchronously; the IME flips it in the background.
        this.targetMode = mode;
        this.logger.debug(`[SingleKB] toggled to ${mode} via ${this.toggleKey}`);
        return { success: true, method: 'toggle', elapsedMs: Date.now() - t0 };
    }
}
