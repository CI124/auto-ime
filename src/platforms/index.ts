/**
 * Platform factory — auto-detect and create the right adapter
 */

import { IPlatformAdapter } from '../core/types';
import { LogSink } from '../logger';

export function createPlatformAdapter(logger: LogSink): IPlatformAdapter {
    if (process.platform === 'win32') {
        const { WindowsAdapter } = require('./windows/adapter');
        const adapter = new WindowsAdapter();
        adapter.init(logger);
        return adapter;
    } else {
        const { LinuxAdapter } = require('./linux/adapter');
        const adapter = new LinuxAdapter();
        adapter.init(logger);
        return adapter;
    }
}
