/**
 * D-Bus 信号测试 (使用正确的 portal 路径)
 */

const dbus = require('dbus-next');
const { execSync } = require('child_process');

const signalLog = [];
let startTime = Date.now();

function logSignal(source, signalName, args) {
    const elapsed = Date.now() - startTime;
    const entry = { source, signal: signalName, args, elapsed: `${elapsed}ms` };
    signalLog.push(entry);
    console.log(`  [${elapsed}ms] ${source}.${signalName}`);
    if (args) console.log(`    Args: ${JSON.stringify(args)}`);
}

function runCmd(cmd) {
    try { return execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim(); }
    catch { return null; }
}

async function main() {
    console.log('🚀 D-Bus Signal Test (Portal Path)\n');
    startTime = Date.now();
    
    const bus = dbus.sessionBus();
    
    // 1. 获取 InputMethod1 接口 (portal 路径)
    console.log('📡 Connecting to /org/freedesktop/portal/inputmethod...');
    const inputMethodObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/org/freedesktop/portal/inputmethod');
    const inputMethodIface = inputMethodObj.getInterface('org.fcitx.Fcitx.InputMethod1');
    console.log('✅ InputMethod1 found');
    
    // 2. 创建 InputContext
    console.log('📡 Creating InputContext...');
    const [contextPath, _] = await inputMethodIface.CreateInputContext([['display', 'x11:'], ['program', 'auto-ime-test']]);
    console.log(`✅ InputContext: ${contextPath}`);
    
    // 3. 获取 InputContext 对象
    const ctxObj = await bus.getProxyObject('org.fcitx.Fcitx5', contextPath);
    
    // 4. Introspect 可用信号
    console.log('\n📡 Available signals:');
    const introspectable = ctxObj.getInterface('org.freedesktop.DBus.Introspectable');
    const xml = await introspectable.Introspect();
    const signals = [...xml.matchAll(/<signal name="([^"]+)">/g)].map(m => m[1]);
    console.log(`  [${signals.join(', ')}]\n`);
    
    // 5. 监听 InputContext1 信号
    console.log('📡 Setting up listeners...');
    const ctxIface = ctxObj.getInterface('org.fcitx.Fcitx.InputContext1');
    
    // 监听所有可能的信号
    const watchSignals = [
        'CurrentIM', 'StatusChanged', 'CommitString', 'ForwardKey',
        'UpdatePreeditText', 'ShowPreeditText', 'HidePreeditText',
        'Enable', 'Disable'
    ];
    
    for (const sig of watchSignals) {
        try {
            ctxIface.on(sig, (...args) => {
                logSignal('InputContext1', sig, args.length > 0 ? args : null);
            });
            console.log(`  ✅ ${sig}`);
        } catch (e) {
            console.log(`  ❌ ${sig} (not available)`);
        }
    }
    
    // 6. 监听 PropertiesChanged
    console.log('\n📡 Setting up PropertiesChanged...');
    const propsIface = ctxObj.getInterface('org.freedesktop.DBus.Properties');
    if (propsIface) {
        propsIface.on('PropertiesChanged', (...args) => {
            logSignal('Properties', 'PropertiesChanged', {
                interface: args[0],
                changed: args[1] ? Object.fromEntries(args[1]) : null,
                invalidated: args[2]
            });
        });
        console.log('  ✅ PropertiesChanged');
    }
    
    // 7. 监听 Controller1 信号
    console.log('\n📡 Setting up Controller1 listeners...');
    try {
        const controllerObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/controller');
        const controllerIface = controllerObj.getInterface('org.fcitx.Fcitx.Controller1');
        controllerIface.on('InputMethodGroupsChanged', (...args) => {
            logSignal('Controller1', 'InputMethodGroupsChanged', args);
        });
        console.log('  ✅ InputMethodGroupsChanged');
    } catch (e) {
        console.log('  ❌ Controller1 not available');
    }
    
    // 8. 测试切换
    console.log('\n🧪 Testing input method switching...\n');
    
    const currentIM = runCmd('fcitx5-remote -n');
    const state = runCmd('fcitx5-remote');
    console.log(`  Initial: IM=${currentIM}, State=${state}`);
    
    console.log('\n  📝 Switch to pinyin...');
    runCmd('fcitx5-remote -s pinyin');
    await new Promise(r => setTimeout(r, 1000));
    
    console.log('  📝 Switch to keyboard-us...');
    runCmd('fcitx5-remote -s keyboard-us');
    await new Promise(r => setTimeout(r, 1000));
    
    console.log('  📝 Toggle (activate)...');
    runCmd('fcitx5-remote -t');
    await new Promise(r => setTimeout(r, 1000));
    
    console.log('  📝 Toggle (deactivate)...');
    runCmd('fcitx5-remote -t');
    await new Promise(r => setTimeout(r, 1000));
    
    // 9. 结果
    console.log('\n📊 Signal Summary:');
    console.log('=================');
    
    if (signalLog.length === 0) {
        console.log('❌ No signals received!\n');
        console.log('Analysis:');
        console.log('  - Fcitx5 may not emit InputContext signals for remote switching');
        console.log('  - Signals may only be emitted for the active/focused InputContext');
        console.log('  - Consider using Controller1 methods to query state instead');
    } else {
        const bySignal = {};
        for (const entry of signalLog) {
            const key = `${entry.source}.${entry.signal}`;
            if (!bySignal[key]) bySignal[key] = [];
            bySignal[key].push(entry);
        }
        for (const [signal, entries] of Object.entries(bySignal)) {
            console.log(`\n✅ ${signal}: ${entries.length} occurrences`);
            for (const e of entries) {
                console.log(`  - [${e.elapsed}] ${JSON.stringify(e.args)}`);
            }
        }
    }
    
    console.log('\n💡 Key Finding:');
    console.log('  The D-Bus monitor showed only method calls (SetCurrentIM, Toggle),');
    console.log('  NOT signals. This means Fcitx5 does NOT emit signals for IME switching.');
    console.log('  The extension should use polling or Controller1.State() method instead.');
}

main().catch(console.error);
