/**
 * Linux Platform Adapter
 * Auto-detects and delegates to Fcitx5 or IBus
 *
 * Business logic:
 * - Fcitx5: reads ~/.config/fcitx5/profile to discover actual input method names
 * - IBus: exact match against configured engine name
 * - PATH: ensures /usr/local/bin, /usr/bin, /bin are available
 * - Detection: uses bash -c "command -v ..." for reliable detection
 *
 * State tracking: adaptive polling (not D-Bus signals)
 * - Fcitx5 signals are NOT emitted for remote switching (fcitx5-remote)
 * - Uses async polling with adaptive intervals for reliability
 * - Active mode: 100ms polling, Idle mode: 500ms polling
 *
 * Fcitx4 removed: deprecated project, users should migrate to Fcitx5
 */

import { exec, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { IPlatformAdapter, SwitchResult, ExternalSwitchSource } from '../../core/types';
import { ValuePoller } from '../../core/poller';
import { LogSink } from '../../infra/logger';

// ========== PATH Helper ==========

function buildEnvPath(): string {
    const existing = process.env.PATH || '';
    const sep = ':';
    const parts = existing.split(sep).filter(Boolean);
    const extras = ['/usr/local/bin', '/usr/bin', '/bin'];
    for (const extra of extras) {
        if (!parts.includes(extra)) {
            parts.push(extra);
        }
    }
    return parts.join(sep);
}

// ========== Bash Helper ==========

/** 输入法框架探测（command -v）允许耗时较长 */
const DETECT_TIMEOUT_MS = 5000;
/** 状态查询 / 切换命令必须快速返回，不阻塞编辑器 */
const QUERY_TIMEOUT_MS = 1000;

function runBash(script: string, args: string[], envPath: string, timeout: number): string {
    return execFileSync('bash', ['-c', script, 'bash_script.sh', ...args], execOptions(timeout, envPath)).trim();
}

function runBashAsync(script: string, envPath: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(`bash -c '${script}'`, execOptions(timeout, envPath), (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

function tryExecBash(script: string, envPath: string, timeout: number): boolean {
    try {
        execFileSync('bash', ['-c', script, 'bash_script.sh'], execOptions(timeout, envPath));
        return true;
    } catch {
        return false;
    }
}

/** runBash / runBashAsync / tryExecBash 共用的 exec 选项（编码 / 超时 / PATH 环境） */
function execOptions(timeout: number, envPath: string) {
    return {
        encoding: 'utf-8' as const,
        timeout,
        env: { ...process.env, PATH: envPath },
    };
}

// ========== Fcitx5 Profile Reader ==========

function readFcitx5Profile(logger: LogSink): { english: string; chinese: string } {
    const defaultEnglish = 'keyboard-us';
    const defaultChinese = 'pinyin';
    const profilePath = path.join(os.homedir(), '.config', 'fcitx5', 'profile');

    try {
        if (!fs.existsSync(profilePath)) {
            logger.info(`[Linux] fcitx5 profile not found: ${profilePath}`);
            return { english: defaultEnglish, chinese: defaultChinese };
        }

        const content = fs.readFileSync(profilePath, 'utf-8');
        const lines = content.split(/\r?\n/);
        const allMethods: string[] = [];
        let inGroupItems = false;

        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;

            if (line.startsWith('[')) {
                inGroupItems = /^\[Groups\/0\/Items\/\d+\]$/.test(line);
                continue;
            }

            if (!inGroupItems) continue;

            if (line.startsWith('Name=') && !line.startsWith('Name=默认')) {
                allMethods.push(line.substring('Name='.length).trim());
            }
        }

        const englishCandidates = allMethods.filter(m => m.includes('keyboard'));
        const english = englishCandidates.includes('keyboard-us')
            ? 'keyboard-us'
            : (englishCandidates[0] || defaultEnglish);

        const chinesePriority = ['rime', 'pinyin', 'shuangpin'];
        const chineseCandidates = allMethods.filter(m => !m.includes('keyboard'));
        const chinese = chinesePriority.find(p => chineseCandidates.includes(p))
            || chineseCandidates[0]
            || defaultChinese;

        logger.info(`[Linux] fcitx5 profile loaded: english=${english}, chinese=${chinese}`);
        return { english, chinese };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Linux] Failed to read fcitx5 profile: ${message}`);
        return { english: defaultEnglish, chinese: defaultChinese };
    }
}

// ========== Adaptive Polling ==========

interface AdaptivePollConfig {
    activeInterval: number;   // 活动状态轮询间隔 (ms)
    idleInterval: number;     // 空闲状态轮询间隔 (ms)
    idleThreshold: number;    // 进入空闲状态的阈值 (ms)
}

const DEFAULT_POLL_CONFIG: AdaptivePollConfig = {
    activeInterval: 100,
    idleInterval: 500,
    idleThreshold: 5000
};

// ========== Linux Adapter ==========

export class LinuxAdapter implements IPlatformAdapter {
    readonly name = 'linux';
    private logger!: LogSink;
    private envPath!: string;
    private manager: LinuxIMEManager | null = null;

    // Adaptive polling state
    private poller: ValuePoller<'zh' | 'en'> | null = null;
    private lastActivityTime: number = Date.now();
    private pollConfig: AdaptivePollConfig = DEFAULT_POLL_CONFIG;

    init(logger: LogSink): void {
        this.logger = logger;
        this.envPath = buildEnvPath();
        logger.info(`[Linux] Using PATH: ${this.envPath}`);

        if (this.isFcitx5Available()) {
            this.manager = new Fcitx5Manager(logger, this.envPath);
            logger.info('[Linux] Using Fcitx5');
        } else if (this.isIBusAvailable()) {
            this.manager = new IBusManager(logger, this.envPath);
            logger.info('[Linux] Using IBus');
        } else {
            logger.warn('[Linux] No supported IME framework detected (Fcitx5/IBus)');
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
        const result = this.manager.switchToEnglish();
        // Update last activity time on switch
        this.lastActivityTime = Date.now();
        return result;
    }

    switchToChinese(): SwitchResult {
        if (!this.manager) return { success: false, method: 'none' };
        const result = this.manager.switchToChinese();
        // Update last activity time on switch
        this.lastActivityTime = Date.now();
        return result;
    }

    /**
     * Sync internal state with actual system state
     * Called on window focus restore
     */
    syncState(): void {
        this.manager?.syncFromSystem();
    }

    /**
     * Start adaptive polling for external manual switches
     *
     * Why polling instead of D-Bus signals?
     * - Fcitx5 does NOT emit InputContext signals for remote switching
     * - dbus-monitor showed only method calls (SetCurrentIM, Toggle), no signals
     * - Async polling with adaptive intervals is reliable and non-blocking
     */
    async startListening(onChange: (mode: 'zh' | 'en') => void): Promise<ExternalSwitchSource> {
        this.lastActivityTime = Date.now();
        this.logger.info(`[Linux] Starting adaptive polling (active=${this.pollConfig.activeInterval}ms, idle=${this.pollConfig.idleInterval}ms)`);
        this.startAdaptivePolling(onChange);
        return 'adapter-polling';
    }

    /**
     * Stop polling
     */
    stopListening(): void {
        if (!this.poller) return;
        this.poller.stop();
        this.poller = null;
        this.logger.info('[Linux] Polling stopped');
    }

    dispose(): void {
        this.stopListening();
    }

    // ========== Adaptive Polling Implementation ==========

    private startAdaptivePolling(onChange: (mode: 'zh' | 'en') => void): void {
        this.poller = new ValuePoller<'zh' | 'en'>(
            () => this.queryModeAsync(),  // async read keeps the cursor hot path unblocked
            (newMode, oldMode) => {
                this.lastActivityTime = Date.now(); // keep high frequency on change
                this.logger.info(`[Linux] Polling detected change: ${oldMode} → ${newMode}`);
                onChange(newMode);
            },
            () => this.getNextInterval(),
            (error) => this.logger.debug(`[Linux] Polling error: ${error}`),
        );
        this.poller.start();
    }

    private getNextInterval(): number {
        const timeSinceActivity = Date.now() - this.lastActivityTime;
        return timeSinceActivity < this.pollConfig.idleThreshold
            ? this.pollConfig.activeInterval
            : this.pollConfig.idleInterval;
    }

    /**
     * Async mode query (non-blocking)
     */
    private async queryModeAsync(): Promise<'zh' | 'en'> {
        if (!this.manager) return 'en';
        return this.manager.queryModeAsync();
    }

    // ========== Detection ==========

    private isFcitx5Available(): boolean {
        return tryExecBash(
            'command -v fcitx5-remote >/dev/null 2>&1 && [ -f "$HOME/.config/fcitx5/profile" ]',
            this.envPath, DETECT_TIMEOUT_MS
        );
    }

    private isIBusAvailable(): boolean {
        return tryExecBash(
            'command -v ibus >/dev/null 2>&1',
            this.envPath, DETECT_TIMEOUT_MS
        );
    }
}

// ========== Internal IME Managers ==========

interface LinuxIMEManager {
    queryMode(): 'zh' | 'en';
    /** 非阻塞查询，供自适应轮询使用 */
    queryModeAsync(): Promise<'zh' | 'en'>;
    switchToEnglish(): SwitchResult;
    switchToChinese(): SwitchResult;
    /** 从系统重新读取真实状态，修正内部缓存 */
    syncFromSystem(): void;
    queryFromSystem(): string;
}

type IMETargets = { english: string; chinese: string };

/**
 * Fcitx5 与 IBus 只在「三条命令 + 日志前缀」上不同，其余行为完全一致：
 * 跟踪目标输入法名、已处于目标则 skip、异步查询失败退回缓存、聚焦时同步。
 * 因此这里只实现一次，子类只提供命令与文案。
 */
abstract class CommandLineImeManager implements LinuxIMEManager {
    protected readonly logger: LogSink;
    protected readonly envPath: string;
    protected readonly englishTarget: string;
    protected readonly chineseTarget: string;
    /** 我们「认为」系统当前选中的输入法名（切换后立即更新，不每次实时读） */
    protected currentTarget: string;

    protected constructor(logger: LogSink, envPath: string, targets: IMETargets) {
        this.logger = logger;
        this.envPath = envPath;
        this.englishTarget = targets.english;
        this.chineseTarget = targets.chinese;
        this.currentTarget = this.queryFromSystem();
    }

    /** 子类在 super() 之后调用：抽象成员只能在构造完成后访问 */
    protected logInitialState(): void {
        this.logger.info(`[${this.logTag}] Initial state: ${this.queryMode()}`);
    }

    /** 日志前缀，如 Fcitx5 / IBus */
    protected abstract get logTag(): string;
    /** SwitchResult.method，如 fcitx5 / ibus */
    protected abstract get switchMethod(): string;
    /** 读取当前输入法的命令（同步与异步轮询共用） */
    protected abstract get queryCommand(): string;
    /** 切换输入法的 bash 脚本，$1 = 目标输入法名 */
    protected abstract get switchScript(): string;
    /** 查询失败时的日志文案 */
    protected abstract get queryErrorLabel(): string;
    /** 切换失败时的日志文案 */
    protected abstract switchErrorLabel(target: string): string;

    queryMode(): 'zh' | 'en' {
        return this.currentTarget === this.englishTarget ? 'en' : 'zh';
    }

    /**
     * Async mode query for polling (non-blocking)
     */
    async queryModeAsync(): Promise<'zh' | 'en'> {
        try {
            const result = await runBashAsync(this.queryCommand, this.envPath, QUERY_TIMEOUT_MS);
            this.currentTarget = result || this.englishTarget;
            return this.queryMode();
        } catch {
            return this.queryMode(); // Fallback to cached sync state
        }
    }

    switchToEnglish(): SwitchResult {
        return this.switchTo(this.englishTarget);
    }

    switchToChinese(): SwitchResult {
        return this.switchTo(this.chineseTarget);
    }

    queryFromSystem(): string {
        const result = this.runBash(this.queryCommand, [], this.queryErrorLabel);
        return result || this.englishTarget;
    }

    syncFromSystem(): void {
        const systemTarget = this.queryFromSystem();
        if (systemTarget !== this.currentTarget) {
            this.logger.info(`[${this.logTag}] Sync: ${this.currentTarget} → ${systemTarget}`);
            this.currentTarget = systemTarget;
        }
    }

    // ========== Private ==========

    private switchTo(target: string): SwitchResult {
        if (this.currentTarget === target) {
            return { success: true, method: 'skip' };
        }
        this.currentTarget = target;
        this.runBash(this.switchScript, [target], this.switchErrorLabel(target));
        return { success: true, method: this.switchMethod };
    }

    private runBash(script: string, args: string[], label: string): string {
        try {
            return runBash(script, args, this.envPath, QUERY_TIMEOUT_MS);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${this.logTag}] ${label} failed: ${message}`);
            return '';
        }
    }
}

// ========== Fcitx5 Manager ==========

const FCITX5_SWITCH_SCRIPT = `fcitx5-remote -s "$1"`;

class Fcitx5Manager extends CommandLineImeManager {
    constructor(logger: LogSink, envPath: string) {
        super(logger, envPath, readFcitx5Profile(logger));
        this.logInitialState();
    }

    protected get logTag(): string { return 'Fcitx5'; }
    protected get switchMethod(): string { return 'fcitx5'; }
    protected get queryCommand(): string { return 'fcitx5-remote -n'; }
    protected get switchScript(): string { return FCITX5_SWITCH_SCRIPT; }
    protected get queryErrorLabel(): string { return 'fcitx5-remote -n'; }
    protected switchErrorLabel(target: string): string { return `fcitx5-remote -s ${target}`; }
}

// ========== IBus Manager ==========

const IBUS_ENGINE_SCRIPT = `ibus engine "$1" &> /dev/null`;

class IBusManager extends CommandLineImeManager {
    constructor(logger: LogSink, envPath: string) {
        super(logger, envPath, IBusManager.readTargets());
        this.logInitialState();
    }

    private static readTargets(): IMETargets {
        const config = vscode.workspace.getConfiguration('auto-ime.ibus');
        return {
            english: config.get<string>('englishEngine') || 'xkb:us::eng',
            chinese: config.get<string>('chineseEngine') || 'libpinyin',
        };
    }

    protected get logTag(): string { return 'IBus'; }
    protected get switchMethod(): string { return 'ibus'; }
    protected get queryCommand(): string { return 'ibus engine'; }
    protected get switchScript(): string { return IBUS_ENGINE_SCRIPT; }
    protected get queryErrorLabel(): string { return 'ibus engine query'; }
    protected switchErrorLabel(target: string): string { return `ibus engine ${target}`; }
}
