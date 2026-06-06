/**
 * Fcitx5 D-Bus IME Signal Listener
 *
 * @deprecated This module is NOT used by the Linux adapter.
 * Testing revealed that Fcitx5 does NOT emit InputContext signals for remote switching.
 * The extension now uses adaptive polling instead (see adapter.ts).
 *
 * Kept for reference and future use if Fcitx5 adds proper signal support.
 *
 * Fcitx5 有两种切换行为，需要分别处理：
 *
 * 1. **输入法切换**（如 Pinyin → English Keyboard）：
 *    - 触发 CurrentIM 信号（InputContext 上）
 *    - 触发 InputMethodChanged 信号（/controller 上）
 *
 * 2. **输入法开关切换**（如 Ctrl+Space 在中英文间切换）：
 *    - 触发 StatusChanged 信号（InputContext 上）
 *    - 触发 PropertiesChanged 信号（D-Bus 标准，IMState 属性变化）
 *    - 不触发 CurrentIM！
 *
 * 本实现同时监听所有相关信号源，确保任何切换方式都能被捕获。
 */

import { LogSink } from '../../logger';

export type IMEChangeCallback = (mode: 'zh' | 'en') => void;

export interface DbusListenerConfig {
    serviceName: string;
    objectPath: string;
    interfaceName: string;
}

export const FCITX5_DBUS: DbusListenerConfig = {
    serviceName: 'org.fcitx.Fcitx5',
    objectPath: '/inputmethod',
    interfaceName: 'org.fcitx.Fcitx.InputMethod1',
};

export const IBUS_DBUS: DbusListenerConfig = {
    serviceName: 'org.freedesktop.IBus',
    objectPath: '/org/freedesktop/IBus',
    interfaceName: 'org.freedesktop.IBus',
};

export class DbusIMEListener {
    private logger: LogSink;
    private handlers: Array<{ iface: any; event: string; handler: (...args: any[]) => void }> = [];
    private connected = false;
    private inputContextPath: string | null = null;
    private queryCurrent: (() => 'zh' | 'en') | null = null;
    private lastKnownMode: 'zh' | 'en' | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;

    constructor(logger: LogSink) {
        this.logger = logger;
    }

    /**
     * Fcitx5 完整事件监听方案：
     *
     * 1. 创建 InputContext（Fcitx5 要求客户端必须创建上下文才能接收信号）
     * 2. 监听 CurrentIM 信号 — 捕获输入法切换（Pinyin ↔ English）
     * 3. 监听 StatusChanged 信号 — 捕获开关切换（Ctrl+Space）
     * 4. 监听 PropertiesChanged — 兜底，捕获所有属性变化
     * 5. 定期轮询作为最终兜底
     */
    async startFcitx5(
        isEnglish: (uniqueName: string, name: string) => boolean,
        queryCurrent: () => 'zh' | 'en',
        callback: IMEChangeCallback,
    ): Promise<boolean> {
        const dbus = require('dbus-next');
        const bus = dbus.sessionBus();
        this.queryCurrent = queryCurrent;
        this.lastKnownMode = queryCurrent();

        // Step 1: 获取 InputMethod1 接口
        let inputMethodObj;
        try {
            inputMethodObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/inputmethod');
        } catch (e) {
            throw new Error(`Fcitx5 InputMethod1 not found at /inputmethod: ${e}`);
        }

        const inputMethodIface = inputMethodObj.getInterface('org.fcitx.Fcitx.InputMethod1');
        if (!inputMethodIface) {
            throw new Error('Interface org.fcitx.Fcitx.InputMethod1 not found');
        }

        // Step 2: 创建 InputContext
        let contextPath: string;
        try {
            contextPath = await inputMethodIface.CreateInputContext('auto-ime', 'vscode');
            this.logger.info(`[D-Bus] InputContext created: ${contextPath}`);
        } catch (e) {
            throw new Error(`CreateInputContext failed: ${e}`);
        }
        this.inputContextPath = contextPath;

        // Step 3: 获取 InputContext 对象
        let contextObj;
        try {
            contextObj = await bus.getProxyObject('org.fcitx.Fcitx5', contextPath);
        } catch (e) {
            throw new Error(`Failed to get InputContext at ${contextPath}: ${e}`);
        }

        // Step 4: Introspect 信号（诊断用）
        try {
            const introspectable = contextObj.getInterface('org.freedesktop.DBus.Introspectable');
            const xml: string = await introspectable.Introspect();
            const signals = [...xml.matchAll(/<signal name="([^"]+)">/g)].map(m => m[1]);
            this.logger.info(`[D-Bus] InputContext signals: [${signals.join(', ')}]`);
        } catch {}

        // Step 5: 监听 InputContext1 上的信号
        const ctxIface = contextObj.getInterface('org.fcitx.Fcitx.InputContext1');
        if (ctxIface) {
            // 5a. CurrentIM — 输入法切换（Pinyin → English Keyboard）
            // 参数: (uniqueName, name, langCode)
            this.addHandler(ctxIface, 'CurrentIM', (uniqueName: string, name: string, langCode: string) => {
                const mode = isEnglish(uniqueName, name) ? 'en' : 'zh';
                this.logger.info(`[D-Bus] CurrentIM: name="${name}" unique="${uniqueName}" lang="${langCode}" → ${mode}`);
                this.emitChange(mode, callback);
            });

            // 5b. StatusChanged — 开关切换（Ctrl+Space）
            // Fcitx5 InputContext1 的 StatusChanged 信号
            this.addHandler(ctxIface, 'StatusChanged', (...args: any[]) => {
                this.logger.info(`[D-Bus] StatusChanged: ${JSON.stringify(args)}`);
                // StatusChanged 不直接告诉我们目标状态，需要查询
                this.queryAndEmit(callback);
            });
        } else {
            this.logger.warn('[D-Bus] InputContext1 interface not found');
        }

        // Step 6: 监听 /controller 上的信号（旧版 Fcitx5 兼容）
        try {
            const controllerObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/controller');
            const controllerIface = controllerObj.getInterface('org.fcitx.Fcitx5.Controller1');
            if (controllerIface) {
                this.addHandler(controllerIface, 'InputMethodChanged', (...args: any[]) => {
                    this.logger.info(`[D-Bus] /controller InputMethodChanged: ${JSON.stringify(args)}`);
                    this.queryAndEmit(callback);
                });
                this.addHandler(controllerIface, 'IMStateChanged', (...args: any[]) => {
                    this.logger.info(`[D-Bus] /controller IMStateChanged: ${JSON.stringify(args)}`);
                    this.queryAndEmit(callback);
                });
                this.logger.info('[D-Bus] Listening on /controller signals');
            }
        } catch (e) {
            this.logger.debug(`[D-Bus] /controller not available: ${e}`);
        }

        // Step 7: PropertiesChanged 兜底
        this.setupPropertiesChanged(bus, contextPath, callback);

        this.connected = true;
        this.logger.info(`[D-Bus] All listeners active for InputContext: ${contextPath}`);
        return true;
    }

    /**
     * Direct signal approach (IBus GlobalEngineChanged)
     */
    async startDirect(
        config: DbusListenerConfig,
        signalName: string,
        isEnglish: (signalParam: string) => boolean,
        callback: IMEChangeCallback,
    ): Promise<boolean> {
        const obj = await this.getProxyObject(config);
        const iface = obj.getInterface(config.interfaceName);
        if (!iface) {
            throw new Error(`Failed to get interface: ${config.interfaceName}`);
        }

        this.addHandler(iface, signalName, (param: string) => {
            const mode = isEnglish(param) ? 'en' : 'zh';
            this.logger.debug(`[D-Bus] ${signalName}: ${param} → ${mode}`);
            this.emitChange(mode, callback);
        });

        this.connected = true;
        this.logger.info(`[D-Bus] Listening (direct): ${config.serviceName} ${signalName}`);
        return true;
    }

    /**
     * Stop all listeners and clean up
     */
    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        for (const { iface, event, handler } of this.handlers) {
            try {
                iface.removeListener(event, handler);
            } catch {}
        }
        this.handlers = [];
        this.connected = false;
        this.logger.info('[D-Bus] All listeners removed');
    }

    isConnected(): boolean {
        return this.connected;
    }

    // ========== Private ==========

    private addHandler(iface: any, event: string, handler: (...args: any[]) => void): void {
        try {
            iface.on(event, handler);
            this.handlers.push({ iface, event, handler });
        } catch (e) {
            this.logger.debug(`[D-Bus] Failed to listen for ${event}: ${e}`);
        }
    }

    /**
     * 发送切换通知（带去重和防抖）
     */
    private emitChange(mode: 'zh' | 'en', callback: IMEChangeCallback): void {
        if (mode === this.lastKnownMode) return;
        this.lastKnownMode = mode;

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.logger.info(`[D-Bus] IME changed → ${mode}`);
            callback(mode);
        }, 50);
    }

    /**
     * 查询当前状态并通知（用于不直接提供目标状态的信号）
     */
    private queryAndEmit(callback: IMEChangeCallback): void {
        if (!this.queryCurrent) return;

        // 防抖：多个信号可能短时间内连续触发
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            try {
                const current = this.queryCurrent!();
                if (current !== this.lastKnownMode) {
                    this.lastKnownMode = current;
                    this.logger.info(`[D-Bus] Query confirmed change → ${current}`);
                    callback(current);
                }
            } catch (e) {
                this.logger.warn(`[D-Bus] Query failed: ${e}`);
            }
        }, 100);
    }

    /**
     * PropertiesChanged 兜底监听
     *
     * Fcitx5 InputContext 的 IMState 属性变化会通过标准 D-Bus
     * Properties.PropertiesChanged 信号广播。
     */
    private setupPropertiesChanged(bus: any, contextPath: string, callback: IMEChangeCallback): void {
        try {
            // dbus-next 的 bus.addSignalHandler 可以匹配特定路径的 PropertiesChanged
            const messageBus = bus;

            // 尝试通过 addMatch 注册信号匹配规则
            const matchRule = [
                `type='signal'`,
                `interface='org.freedesktop.DBus.Properties'`,
                `member='PropertiesChanged'`,
                `path='${contextPath}'`,
            ].join(',');

            // dbus-next 可能不支持直接 addMatch，使用 try-catch
            bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
                .then((dbusObj: any) => {
                    const dbusIface = dbusObj.getInterface('org.freedesktop.DBus');
                    if (dbusIface) {
                        return dbusIface.AddMatch(matchRule);
                    }
                })
                .then(() => {
                    this.logger.info(`[D-Bus] PropertiesChanged match added for ${contextPath}`);
                })
                .catch((e: any) => {
                    this.logger.debug(`[D-Bus] AddMatch failed (non-critical): ${e}`);
                });

            // 监听 bus 上的 signal
            if (typeof bus.on === 'function') {
                const busHandler = (msg: any) => {
                    if (msg.interface === 'org.freedesktop.DBus.Properties' &&
                        msg.member === 'PropertiesChanged' &&
                        msg.path === contextPath) {
                        this.logger.info(`[D-Bus] PropertiesChanged on ${contextPath}`);
                        this.queryAndEmit(callback);
                    }
                };
                bus.on('message', busHandler);
                this.handlers.push({ iface: bus, event: 'message', handler: busHandler });
            }
        } catch (e) {
            this.logger.debug(`[D-Bus] PropertiesChanged setup failed (non-critical): ${e}`);
        }
    }

    private async getProxyObject(config: DbusListenerConfig): Promise<any> {
        const dbus = require('dbus-next');
        const bus = dbus.sessionBus();
        try {
            return await bus.getProxyObject(config.serviceName, config.objectPath);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`D-Bus service not found: ${config.serviceName} at ${config.objectPath} - ${msg}`);
        }
    }
}
