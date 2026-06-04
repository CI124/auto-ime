/**
 * Linux Platform Adapter
 * Auto-detects and delegates to Fcitx5, Fcitx4, or IBus
 */

import { execSync } from 'child_process';
import * as vscode from 'vscode';
import { IPlatformAdapter, SwitchResult } from '../../core/types';
import { LogSink } from '../../logger';

export class LinuxAdapter implements IPlatformAdapter {
    readonly name = 'linux';
    private logger!: LogSink;
    private manager: LinuxIMEManager | null = null;

    init(logger: LogSink): void {
        this.logger = logger;

        if (this.isFcitx5Available()) {
            this.manager = new Fcitx5Manager(logger);
            logger.info('[Linux] Using Fcitx5');
        } else if (this.isFcitx4Available()) {
            this.manager = new Fcitx4Manager(logger);
            logger.info('[Linux] Using Fcitx4');
        } else if (this.isIBusAvailable()) {
            this.manager = new IBusManager(logger);
            logger.info('[Linux] Using IBus');
        } else {
            logger.warn('[Linux] No supported IME framework detected');
        }
    }

    isReady(): boolean {
        return this.manager !== null;
    }

    queryMode(): 'zh' | 'en' {
        if (!this.manager) return 'en';
        return this.manager.queryMode();
    }

    switchToEnglish(): SwitchResult {
        if (!this.manager) return { success: false, method: 'none' };
        return this.manager.switchToEnglish();
    }

    switchToChinese(): SwitchResult {
        if (!this.manager) return { success: false, method: 'none' };
        return this.manager.switchToChinese();
    }

    dispose(): void {
        // nothing to clean up
    }

    // ========== Detection ==========

    private isFcitx5Available(): boolean {
        try {
            execSync('fcitx5-remote -n', { encoding: 'utf-8', timeout: 500 });
            return true;
        } catch {
            return false;
        }
    }

    private isFcitx4Available(): boolean {
        try {
            execSync('fcitx-remote -n', { encoding: 'utf-8', timeout: 500 });
            return true;
        } catch {
            return false;
        }
    }

    private isIBusAvailable(): boolean {
        try {
            execSync('ibus engine', { encoding: 'utf-8', timeout: 500 });
            return true;
        } catch {
            return false;
        }
    }
}

// ========== Internal IME Managers ==========

interface LinuxIMEManager {
    queryMode(): 'zh' | 'en';
    switchToEnglish(): SwitchResult;
    switchToChinese(): SwitchResult;
}

class Fcitx5Manager implements LinuxIMEManager {
    private logger: LogSink;
    private englishTarget: string;
    private chineseTarget: string;

    constructor(logger: LogSink) {
        this.logger = logger;
        const config = vscode.workspace.getConfiguration('auto-ime.fcitx5');
        this.englishTarget = config.get<string>('englishEngine') || 'keyboard-us';
        this.chineseTarget = config.get<string>('chineseEngine') || 'fcitx5-pinyin';
    }

    queryMode(): 'zh' | 'en' {
        try {
            const result = execSync('fcitx5-remote -n', { encoding: 'utf-8', timeout: 500 }).trim();
            return result.includes('keyboard') || result.includes('xkb') ? 'en' : 'zh';
        } catch {
            return 'en';
        }
    }

    switchToEnglish(): SwitchResult {
        return this.switchTo(this.englishTarget, 'EN');
    }

    switchToChinese(): SwitchResult {
        return this.switchTo(this.chineseTarget, 'ZH');
    }

    private switchTo(target: string, label: string): SwitchResult {
        try {
            execSync(`fcitx5-remote -s ${target}`, { encoding: 'utf-8', timeout: 500 });
            this.logger.debug(`[Fcitx5] ${label}: ok`);
            return { success: true, method: 'fcitx5' };
        } catch (e) {
            this.logger.error(`[Fcitx5] ${label}: failed - ${e}`);
            return { success: false, method: 'none' };
        }
    }
}

class Fcitx4Manager implements LinuxIMEManager {
    private logger: LogSink;

    constructor(logger: LogSink) {
        this.logger = logger;
    }

    queryMode(): 'zh' | 'en' {
        try {
            const result = execSync('fcitx-remote', { encoding: 'utf-8', timeout: 500 }).trim();
            return result === '1' ? 'en' : 'zh';
        } catch {
            return 'en';
        }
    }

    switchToEnglish(): SwitchResult {
        return this.runCommand('fcitx-remote -c', 'EN');
    }

    switchToChinese(): SwitchResult {
        return this.runCommand('fcitx-remote -o', 'ZH');
    }

    private runCommand(cmd: string, label: string): SwitchResult {
        try {
            execSync(cmd, { encoding: 'utf-8', timeout: 500 });
            this.logger.debug(`[Fcitx4] ${label}: ok`);
            return { success: true, method: 'fcitx4' };
        } catch (e) {
            this.logger.error(`[Fcitx4] ${label}: failed - ${e}`);
            return { success: false, method: 'none' };
        }
    }
}

class IBusManager implements LinuxIMEManager {
    private logger: LogSink;
    private englishEngine: string;
    private chineseEngine: string;

    constructor(logger: LogSink) {
        this.logger = logger;
        const config = vscode.workspace.getConfiguration('auto-ime.ibus');
        this.englishEngine = config.get<string>('englishEngine') || 'xkb:us::eng';
        this.chineseEngine = config.get<string>('chineseEngine') || 'libpinyin';
    }

    queryMode(): 'zh' | 'en' {
        try {
            const result = execSync('ibus engine', { encoding: 'utf-8', timeout: 500 }).trim();
            return result.includes('xkb') || result.includes('eng') ? 'en' : 'zh';
        } catch {
            return 'en';
        }
    }

    switchToEnglish(): SwitchResult {
        return this.switchTo(this.englishEngine, 'EN');
    }

    switchToChinese(): SwitchResult {
        return this.switchTo(this.chineseEngine, 'ZH');
    }

    private switchTo(engine: string, label: string): SwitchResult {
        try {
            execSync(`ibus engine ${engine}`, { encoding: 'utf-8', timeout: 500 });
            this.logger.debug(`[IBus] ${label}: ok`);
            return { success: true, method: 'ibus' };
        } catch (e) {
            this.logger.error(`[IBus] ${label}: failed - ${e}`);
            return { success: false, method: 'none' };
        }
    }
}
