/**
 * Persistent PowerShell process for fast TSF operations
 * Avoids ~300ms process startup overhead on each call
 *
 * Communication protocol:
 *   stdin  -> "QUERY" | "SET:0" | "SET:1" | "EXIT"
 *   stdout <- "INIT:OK" | "INIT:FAIL" | "QUERY:0" | "QUERY:1" | "SET:OK" | ...
 */

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { LogSink } from '../logger';

type PendingCall = {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

export class TSFPipe {
    private process: ChildProcess | null = null;
    private logger: LogSink;
    private pending: PendingCall | null = null;
    private buffer = '';
    private initialized = false;
    private initPromise: Promise<boolean> | null = null;

    constructor(logger: LogSink) {
        this.logger = logger;
    }

    /**
     * Start the persistent PowerShell process
     * Returns true if TSF is available
     */
    async initialize(): Promise<boolean> {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._doInit();
        return this.initPromise;
    }

    private async _doInit(): Promise<boolean> {
        // Write the TSF helper script to a temp file
        const scriptContent = `
# Auto IME TSF Persistent Pipe
# Reads commands from stdin, writes results to stdout
$ErrorActionPreference = "SilentlyContinue"

# Initialize TSF COM objects once
$tsf = $null
$tsfAvailable = $false

try {
    $tsf = New-Object -ComObject MsTf.TF_ThreadMgr
    if ($tsf) {
        $tsfAvailable = $true
    }
} catch {
    Write-Output "INIT:ERROR:$_"
}

if ($tsfAvailable) {
    Write-Output "INIT:OK"
} else {
    Write-Output "INIT:FAIL"
}

# Command loop
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq "") { continue }
    if ($line -eq "EXIT") { break }

    if ($line -eq "QUERY") {
        try {
            $clientId = 0
            $tsf.Activate([ref]$clientId)
            $docMgr = $tsf.GetFocus()
            if ($docMgr) {
                $compMgr = $docMgr -as [Msctf.ITfCompartmentMgr]
                if ($compMgr) {
                    $comp = $compMgr.GetCompartment([Guid]'58273AAD-01BB-4164-95C6-755BA0B5162D')
                    if ($comp) {
                        $val = $comp.GetValue()
                        Write-Output "QUERY:$val"
                    } else {
                        Write-Output "QUERY:ERROR:NO_COMPARTMENT"
                    }
                } else {
                    Write-Output "QUERY:ERROR:NO_COMPMGR"
                }
            } else {
                Write-Output "QUERY:ERROR:NO_DOCMGR"
            }
            $tsf.Deactivate()
        } catch {
            Write-Output "QUERY:ERROR:$_"
            try { $tsf.Deactivate() } catch {}
        }
    }
    elseif ($line -match "^SET:(\\d+)$") {
        $val = $Matches[1]
        try {
            $clientId = 0
            $tsf.Activate([ref]$clientId)
            $docMgr = $tsf.GetFocus()
            if ($docMgr) {
                $compMgr = $docMgr -as [Msctf.ITfCompartmentMgr]
                if ($compMgr) {
                    $comp = $compMgr.GetCompartment([Guid]'58273AAD-01BB-4164-95C6-755BA0B5162D')
                    if ($comp) {
                        $comp.SetValue([int]$val)
                        Write-Output "SET:OK"
                    } else {
                        Write-Output "SET:ERROR:NO_COMPARTMENT"
                    }
                } else {
                    Write-Output "SET:ERROR:NO_COMPMGR"
                }
            } else {
                Write-Output "SET:ERROR:NO_DOCMGR"
            }
            $tsf.Deactivate()
        } catch {
            Write-Output "SET:ERROR:$_"
            try { $tsf.Deactivate() } catch {}
        }
    }
    else {
        Write-Output "UNKNOWN:$line"
    }
}

if ($tsf) {
    try { $tsf.Deactivate() } catch {}
}
`;

        const scriptPath = path.join(os.tmpdir(), 'auto-ime-tsf-pipe.ps1');
        try {
            fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
        } catch (e) {
            this.logger.error(`[TSFPipe] Failed to write script: ${e}`);
            return false;
        }

        return new Promise<boolean>((resolve) => {
            try {
                this.process = spawn('powershell', [
                    '-NoProfile',
                    '-ExecutionPolicy', 'Bypass',
                    '-File', scriptPath
                ], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true
                });

                let initResolved = false;

                this.process.stdout?.on('data', (data: Buffer) => {
                    this.buffer += data.toString();
                    // Process complete lines
                    let newlineIdx: number;
                    while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
                        const line = this.buffer.substring(0, newlineIdx).trim();
                        this.buffer = this.buffer.substring(newlineIdx + 1);

                        if (!initResolved) {
                            if (line === 'INIT:OK') {
                                initResolved = true;
                                this.initialized = true;
                                this.logger.info('[TSFPipe] TSF initialized successfully');
                                resolve(true);
                            } else if (line.startsWith('INIT:ERROR') || line === 'INIT:FAIL') {
                                initResolved = true;
                                this.logger.error(`[TSFPipe] TSF init failed: ${line}`);
                                resolve(false);
                            }
                            continue;
                        }

                        // Handle command responses
                        if (this.pending) {
                            const p = this.pending;
                            this.pending = null;
                            clearTimeout(p.timer);
                            p.resolve(line);
                        }
                    }
                });

                this.process.stderr?.on('data', (data: Buffer) => {
                    this.logger.error(`[TSFPipe] stderr: ${data.toString().trim()}`);
                });

                this.process.on('exit', (code) => {
                    this.logger.info(`[TSFPipe] Process exited with code ${code}`);
                    this.process = null;
                    this.initialized = false;
                    this.initPromise = null;
                    if (!initResolved) {
                        initResolved = true;
                        resolve(false);
                    }
                    // Reject any pending call
                    if (this.pending) {
                        this.pending.reject(new Error('Process exited'));
                        this.pending = null;
                    }
                });

                this.process.on('error', (e) => {
                    this.logger.error(`[TSFPipe] Process error: ${e}`);
                    this.process = null;
                    this.initialized = false;
                    this.initPromise = null;
                    if (!initResolved) {
                        initResolved = true;
                        resolve(false);
                    }
                });

                // Timeout for init
                setTimeout(() => {
                    if (!initResolved) {
                        initResolved = true;
                        this.logger.error('[TSFPipe] Init timeout (5s)');
                        resolve(false);
                    }
                }, 5000);

            } catch (e) {
                this.logger.error(`[TSFPipe] Failed to spawn: ${e}`);
                resolve(false);
            }
        });
    }

    /**
     * Query TSF mode via persistent pipe
     * Returns 'zh' | 'en' | null
     */
    async queryMode(): Promise<'zh' | 'en' | null> {
        if (!this.initialized || !this.process) return null;

        const response = await this.sendCommand('QUERY');
        if (!response) return null;

        // Response format: "QUERY:0" or "QUERY:1" or "QUERY:ERROR:..."
        const match = response.match(/^QUERY:(\d+)$/);
        if (match) {
            const result = parseInt(match[1], 10) !== 0 ? 'zh' : 'en';
            this.logger.debug(`[TSFPipe] queryMode: ${result}`);
            return result;
        }
        return null;
    }

    /**
     * Set TSF mode via persistent pipe
     */
    async setMode(chinese: boolean): Promise<boolean> {
        if (!this.initialized || !this.process) return false;

        const val = chinese ? 1 : 0;
        const response = await this.sendCommand(`SET:${val}`);
        const ok = response === 'SET:OK';
        this.logger.debug(`[TSFPipe] setMode(${chinese}): ${ok ? 'ok' : 'fail'}`);
        return ok;
    }

    /**
     * Send a command and wait for response
     */
    private sendCommand(cmd: string): Promise<string | null> {
        return new Promise((resolve) => {
            if (!this.process || !this.process.stdin) {
                resolve(null);
                return;
            }

            this.logger.debug(`[TSFPipe] sendCommand: ${cmd}`);

            const timer = setTimeout(() => {
                if (this.pending) {
                    this.pending = null;
                    this.logger.error(`[TSFPipe] Command timeout: ${cmd}`);
                    resolve(null);
                }
            }, 2000);

            this.pending = { resolve, reject: () => {}, timer };
            this.process.stdin.write(cmd + '\n');
        });
    }

    /**
     * Check if TSF is available and pipe is working
     */
    isAvailable(): boolean {
        return this.initialized && this.process !== null;
    }

    /**
     * Kill the persistent process
     */
    dispose(): void {
        this.logger.info('[TSFPipe] dispose: shutting down pipe');
        if (this.process) {
            try {
                this.process.stdin?.write('EXIT\n');
                setTimeout(() => {
                    this.process?.kill();
                }, 500);
            } catch {}
            this.process = null;
        }
        this.initialized = false;
        this.initPromise = null;
    }
}
