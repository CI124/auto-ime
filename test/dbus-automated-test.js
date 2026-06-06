/**
 * D-Bus 信号自动化测试脚本
 * 
 * 使用 fcitx5-remote 命令模拟输入法切换，验证信号是否正确触发
 */

const dbus = require('dbus-next');
const { execSync } = require('child_process');

const signalLog = [];
let signalCount = 0;
let startTime = Date.now();

function logSignal(source, signalName, args) {
    signalCount++;
    const elapsed = Date.now() - startTime;
    const entry = {
        id: signalCount,
        source,
        signal: signalName,
        args: args ? JSON.stringify(args) : '(none)',
        elapsed: `${elapsed}ms`,
    };
    signalLog.push(entry);
    
    console.log(`  [${elapsed}ms] #${signalCount} ${source}.${signalName}`);
    console.log(`    Args: ${entry.args}`);
}

function runCommand(cmd) {
    try {
        return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch (e) {
        return null;
    }
}

async function setupFcitx5Listeners(bus) {
    console.log('📡 Setting up Fcitx5 listeners...');
    
    const controllerObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/controller');
    const controllerIface = controllerObj.getInterface('org.fcitx.Fcitx.Controller1');
    
    // 监听 PropertiesChanged
    controllerObj.getInterface('org.freedesktop.DBus.Properties').on('PropertiesChanged', (...args) => {
        logSignal('Fcitx5.Properties', 'PropertiesChanged', {
            interface: args[0],
            changed: args[1],
            invalidated: args[2]
        });
    });
    
    // 监听 InputMethodGroupsChanged
    controllerIface.on('InputMethodGroupsChanged', (...args) => {
        logSignal('Fcitx5.Controller1', 'InputMethodGroupsChanged', args);
    });
    
    console.log('✅ Fcitx5 listeners ready');
    return controllerIface;
}

async function setupIBusListeners(bus) {
    console.log('📡 Setting up IBus listeners...');
    
    const ibusObj = await bus.getProxyObject('org.freedesktop.IBus', '/org/freedesktop/IBus');
    const ibusIface = ibusObj.getInterface('org.freedesktop.IBus');
    
    // 创建 InputContext
    const contextPath = await ibusIface.CreateInputContext('auto-ime-test');
    console.log(`  InputContext: ${contextPath}`);
    
    const ctxObj = await bus.getProxyObject('org.freedesktop.IBus', contextPath);
    const ctxIface = ctxObj.getInterface('org.freedesktop.IBus.InputContext');
    
    // 监听关键信号
    const signals = [
        'CommitText', 'ForwardKeyEvent', 'Enable', 'Disable',
        'UpdatePreeditText', 'ShowPreeditText', 'HidePreeditText'
    ];
    
    for (const signal of signals) {
        ctxIface.on(signal, (...args) => {
            logSignal('IBus.InputContext', signal, args);
        });
    }
    
    // 监听全局信号
    ibusIface.on('GlobalEngineChanged', (...args) => {
        logSignal('IBus.Global', 'GlobalEngineChanged', args);
    });
    
    console.log('✅ IBus listeners ready');
    return ibusIface;
}

async function testFcitx5Switch(controllerIface) {
    console.log('\n🧪 Testing Fcitx5 input method switching...');
    
    // 获取当前输入法
    const currentIM = await controllerIface.CurrentInputMethod();
    console.log(`  Current IM: ${currentIM || '(none)'}`);
    
    // 获取状态
    const state = await controllerIface.State();
    console.log(`  State: ${state} (${state === 1 ? 'inactive' : state === 2 ? 'active' : 'unknown'})`);
    
    // 切换到中文
    console.log('\n  📝 Switching to Chinese (pinyin)...');
    runCommand('fcitx5-remote -s pinyin');
    await new Promise(r => setTimeout(r, 500));
    
    const stateAfterSwitch = await controllerIface.State();
    console.log(`  State after switch: ${stateAfterSwitch} (${stateAfterSwitch === 1 ? 'inactive' : stateAfterSwitch === 2 ? 'active' : 'unknown'})`);
    
    // 切换回英文
    console.log('\n  📝 Switching to English (keyboard-us)...');
    runCommand('fcitx5-remote -s keyboard-us');
    await new Promise(r => setTimeout(r, 500));
    
    const stateAfterSwitchBack = await controllerIface.State();
    console.log(`  State after switch back: ${stateAfterSwitchBack} (${stateAfterSwitchBack === 1 ? 'inactive' : stateAfterSwitchBack === 2 ? 'active' : 'unknown'})`);
}

async function testFcitx5Toggle() {
    console.log('\n🧪 Testing Fcitx5 toggle (Ctrl+Space simulation)...');
    
    // 模拟 Ctrl+Space 切换
    console.log('  📝 Toggling IME (fcitx5-remote -t)...');
    runCommand('fcitx5-remote -t');
    await new Promise(r => setTimeout(r, 500));
    
    const state = runCommand('fcitx5-remote');
    console.log(`  State after toggle: ${state} (${state === '1' ? 'inactive' : state === '2' ? 'active' : 'unknown'})`);
    
    // 再次切换回来
    console.log('  📝 Toggling back...');
    runCommand('fcitx5-remote -t');
    await new Promise(r => setTimeout(r, 500));
    
    const stateAfter = runCommand('fcitx5-remote');
    console.log(`  State after toggle back: ${stateAfter} (${stateAfter === '1' ? 'inactive' : stateAfter === '2' ? 'active' : 'unknown'})`);
}

async function main() {
    console.log('🚀 D-Bus Signal Automation Test');
    console.log('================================\n');
    
    startTime = Date.now();
    
    const bus = dbus.sessionBus();
    
    // 设置监听器
    let controllerIface;
    try {
        controllerIface = await setupFcitx5Listeners(bus);
    } catch (e) {
        console.log('❌ Fcitx5 setup failed:', e.message);
    }
    
    try {
        await setupIBusListeners(bus);
    } catch (e) {
        console.log('❌ IBus setup failed:', e.message);
    }
    
    // 测试 Fcitx5 切换
    if (controllerIface) {
        await testFcitx5Switch(controllerIface);
        await testFcitx5Toggle();
    }
    
    // 等待信号
    console.log('\n⏳ Waiting for signals...');
    await new Promise(r => setTimeout(r, 2000));
    
    // 输出结果
    console.log('\n📊 Signal Summary:');
    console.log('=================');
    
    if (signalLog.length === 0) {
        console.log('❌ No signals received!');
        console.log('\n🔍 Analysis:');
        console.log('  - Fcitx5/IBus may not be emitting signals');
        console.log('  - Signal listeners may not be properly connected');
        console.log('  - The D-Bus connection may be using a different session');
    } else {
        // 按信号类型分组
        const bySignal = {};
        for (const entry of signalLog) {
            const key = `${entry.source}.${entry.signal}`;
            if (!bySignal[key]) bySignal[key] = [];
            bySignal[key].push(entry);
        }
        
        for (const [signal, entries] of Object.entries(bySignal)) {
            console.log(`\n✅ ${signal}: ${entries.length} occurrences`);
            for (const entry of entries) {
                console.log(`  - [${entry.elapsed}] Args: ${entry.args}`);
            }
        }
        
        console.log(`\n📈 Total: ${signalLog.length} signals received`);
    }
    
    // 建议
    console.log('\n💡 Recommendations:');
    if (signalLog.length === 0) {
        console.log('  1. Check if Fcitx5/IBus is configured to emit D-Bus signals');
        console.log('  2. Verify D-Bus session address is correct');
        console.log('  3. Check if signals are emitted on a different interface');
    } else {
        console.log('  1. Use the received signals for IME state tracking');
        console.log('  2. Implement debouncing if signals fire too frequently');
        console.log('  3. Consider fallback to polling if signals are unreliable');
    }
}

main().catch(console.error);
