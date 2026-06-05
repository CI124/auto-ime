/**
 * Generic D-Bus IME Signal Listener
 *
 * Abstracts Fcitx5 and IBus signal listening into a unified interface.
 * D-Bus signals are push-based (event-driven), not polling.
 *
 * Fcitx5: org.fcitx.Fcitx5 / /controller / InputMethodChanged
 * IBus:   org.freedesktop.IBus / /org/freedesktop/IBus / GlobalEngineChanged
 */

import { LogSink } from '../../logger';

export type IMEChangeCallback = (mode: 'zh' | 'en') => void;

export interface DbusListenerConfig {
    serviceName: string;
    objectPath: string;
    interfaceName: string;
    signalName: string;
}

export const FCITX5_DBUS: DbusListenerConfig = {
    serviceName: 'org.fcitx.Fcitx5',
    objectPath: '/controller',
    interfaceName: 'org.fcitx.Fcitx5.Controller1',
    signalName: 'InputMethodChanged',
};

export const IBUS_DBUS: DbusListenerConfig = {
    serviceName: 'org.freedesktop.IBus',
    objectPath: '/org/freedesktop/IBus',
    interfaceName: 'org.freedesktop.IBus',
    signalName: 'GlobalEngineChanged',
};

export class DbusIMEListener {
    private logger: LogSink;
    private handler: ((...args: any[]) => void) | null = null;
    private iface: any = null;
    private connected = false;

    constructor(logger: LogSink) {
        this.logger = logger;
    }

    /**
     * Start listening for D-Bus IME change signals
     * Returns true if successfully connected
     */
    async start(
        config: DbusListenerConfig,
        isEnglish: (signalParam: string) => boolean,
        callback: IMEChangeCallback,
    ): Promise<boolean> {
        try {
            const dbus = require('dbus-next');
            const bus = dbus.sessionBus();

            const obj = await bus.getProxyObject(config.serviceName, config.objectPath);
            this.iface = obj.getInterface(config.interfaceName);

            this.handler = (param: string) => {
                const mode = isEnglish(param) ? 'en' : 'zh';
                this.logger.debug(`[D-Bus] ${config.signalName}: ${param} → ${mode}`);
                callback(mode);
            };

            this.iface.on(config.signalName, this.handler);
            this.connected = true;
            this.logger.info(`[D-Bus] Listening: ${config.serviceName} ${config.signalName}`);
            return true;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.info(`[D-Bus] Not available: ${config.serviceName} - ${msg}`);
            return false;
        }
    }

    /**
     * Stop listening
     */
    stop(): void {
        if (this.iface && this.handler) {
            try {
                this.iface.removeAllListeners();
            } catch {}
            this.iface = null;
            this.handler = null;
        }
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }
}
