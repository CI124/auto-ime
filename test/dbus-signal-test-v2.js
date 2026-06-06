/**
 * D-Bus 信号监听测试脚本 (改进版)
 * 
 * 用法: 
 *   export DISPLAY=:99
 *   export DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/dbus-jw9LmYjM7H"
 *   node test/dbus-signal-test-v2.js
 */

const dbus = require('dbus-next');

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
    
    console.log(`\n[${elapsed}ms] #${signalCount} ${source}.${signalName}`);
    console.log(`  Args: ${entry.args}`);
}

async function testFcitx5() {
    console.log('🔍 Testing Fcitx5...\n');
    
    const bus = dbus.sessionBus();
    
    try {
        // 获取 Controller1 接口
        const controllerObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/controller');
        const controllerIface = controllerObj.getInterface('org.fcitx.Fcitx.Controller1');
        
        if (!controllerIface) {
            console.log('❌ Controller1 interface not found');
            return false;
        }
        
        console.log('✅ Controller1 found');
        
        // 获取当前输入法
        try {
            const currentIM = await controllerIface.CurrentInputMethod();
            console.log(`  Current input method: ${currentIM}`);
        } catch (e) {
            console.log('  Cannot get current IM:', e.message);
        }
        
        // 获取状态
        try {
            const state = await controllerIface.State();
            console.log(`  State: ${state}`);
        } catch (e) {
            console.log('  Cannot get state:', e.message);
        }
        
        // 监听信号
        console.log('\n📡 Setting up Fcitx5 signal listeners...');
        
        // InputMethodGroupsChanged 信号
        controllerIface.on('InputMethodGroupsChanged', (...args) => {
            logSignal('Fcitx5.Controller1', 'InputMethodGroupsChanged', args);
        });
        console.log('✅ Listening for InputMethodGroupsChanged');
        
        // PropertiesChanged 信号
        controllerObj.getInterface('org.freedesktop.DBus.Properties').on('PropertiesChanged', (...args) => {
            logSignal('Fcitx5.Properties', 'PropertiesChanged', {
                interface: args[0],
                changed: args[1],
                invalidated: args[2]
            });
        });
        console.log('✅ Listening for PropertiesChanged');
        
        return true;
    } catch (e) {
        console.log('❌ Fcitx5 test failed:', e.message);
        return false;
    }
}

async function testIBus() {
    console.log('\n🔍 Testing IBus...\n');
    
    const bus = dbus.sessionBus();
    
    try {
        // 获取 IBus 接口
        const ibusObj = await bus.getProxyObject('org.freedesktop.IBus', '/org/freedesktop/IBus');
        const ibusIface = ibusObj.getInterface('org.freedesktop.IBus');
        
        if (!ibusIface) {
            console.log('❌ IBus interface not found');
            return false;
        }
        
        console.log('✅ IBus found');
        
        // 创建 InputContext
        console.log('📡 Creating InputContext...');
        let contextPath;
        try {
            contextPath = await ibusIface.CreateInputContext('auto-ime-test');
            console.log(`✅ InputContext created: ${contextPath}`);
        } catch (e) {
            console.log('❌ CreateInputContext failed:', e.message);
            return false;
        }
        
        // 获取 InputContext 对象
        const ctxObj = await bus.getProxyObject('org.freedesktop.IBus', contextPath);
        
        // Introspect 信号
        console.log('\n📡 Introspecting InputContext signals...');
        try {
            const introspectable = ctxObj.getInterface('org.freedesktop.DBus.Introspectable');
            const xml = await introspectable.Introspect();
            const signals = [...xml.matchAll(/<signal name="([^"]+)">/g)].map(m => m[1]);
            console.log(`✅ Available signals: [${signals.join(', ')}]`);
        } catch (e) {
            console.log('⚠️  Introspection failed:', e.message);
        }
        
        // 监听 InputContext 信号
        console.log('\n📡 Setting up IBus InputContext listeners...');
        const ctxIface = ctxObj.getInterface('org.freedesktop.IBus.InputContext');
        if (ctxIface) {
            // CommitText 信号
            ctxIface.on('CommitText', (...args) => {
                logSignal('IBus.InputContext', 'CommitText', args);
            });
            console.log('✅ Listening for CommitText');
            
            // ForwardKeyEvent 信号
            ctxIface.on('ForwardKeyEvent', (...args) => {
                logSignal('IBus.InputContext', 'ForwardKeyEvent', args);
            });
            console.log('✅ Listening for ForwardKeyEvent');
            
            // UpdatePreeditText 信号
            ctxIface.on('UpdatePreeditText', (...args) => {
                logSignal('IBus.InputContext', 'UpdatePreeditText', args);
            });
            console.log('✅ Listening for UpdatePreeditText');
            
            // ShowPreeditText 信号
            ctxIface.on('ShowPreeditText', (...args) => {
                logSignal('IBus.InputContext', 'ShowPreeditText', args);
            });
            console.log('✅ Listening for ShowPreeditText');
            
            // HidePreeditText 信号
            ctxIface.on('HidePreeditText', (...args) => {
                logSignal('IBus.InputContext', 'HidePreeditText', args);
            });
            console.log('✅ Listening for HidePreeditText');
            
            // Enable 信号
            ctxIface.on('Enable', (...args) => {
                logSignal('IBus.InputContext', 'Enable', args);
            });
            console.log('✅ Listening for Enable');
            
            // Disable 信号
            ctxIface.on('Disable', (...args) => {
                logSignal('IBus.InputContext', 'Disable', args);
            });
            console.log('✅ Listening for Disable');
            
            // SetCapabilities 信号
            ctxIface.on('SetCapabilities', (...args) => {
                logSignal('IBus.InputContext', 'SetCapabilities', args);
            });
            console.log('✅ Listening for SetCapabilities');
            
            // CursorUpDown 信号
            ctxIface.on('CursorUpDown', (...args) => {
                logSignal('IBus.InputContext', 'CursorUpDown', args);
            });
            console.log('✅ Listening for CursorUpDown');
        }
        
        // 监听全局 IBus 信号
        console.log('\n📡 Setting up global IBus listeners...');
        const globalIface = ibusObj.getInterface('org.freedesktop.IBus');
        if (globalIface) {
            // GlobalEngineChanged 信号
            globalIface.on('GlobalEngineChanged', (...args) => {
                logSignal('IBus.Global', 'GlobalEngineChanged', args);
            });
            console.log('✅ Listening for GlobalEngineChanged');
        }
        
        return true;
    } catch (e) {
        console.log('❌ IBus test failed:', e.message);
        return false;
    }
}

async function main() {
    console.log('🚀 D-Bus Signal Test Script (v2)');
    console.log('================================\n');
    console.log('This script will listen for D-Bus signals from Fcitx5/IBus.');
    console.log('Please switch input methods manually and observe the output.');
    console.log('Press Ctrl+C to stop.\n');
    
    startTime = Date.now();
    
    const fcitx5Available = await testFcitx5();
    const ibusAvailable = await testIBus();
    
    if (!fcitx5Available && !ibusAvailable) {
        console.log('\n❌ Neither Fcitx5 nor IBus detected. Exiting.');
        process.exit(1);
    }
    
    console.log('\n✅ Listening for signals... (switch input methods to test)');
    console.log('   - Try Ctrl+Space to toggle IME on/off');
    console.log('   - Try switching between input methods');
    console.log('   - Try using system tray to switch');
    console.log('   - Try typing in different contexts\n');
    
    // 定期显示统计信息
    setInterval(() => {
        if (signalLog.length > 0) {
            console.log(`\n📊 Total signals received: ${signalLog.length}`);
        }
    }, 15000);
}

// 优雅退出
process.on('SIGINT', () => {
    console.log('\n\n📊 Signal Summary:');
    console.log('=================');
    
    if (signalLog.length === 0) {
        console.log('No signals received.');
    } else {
        // 按信号类型分组
        const bySignal = {};
        for (const entry of signalLog) {
            const key = `${entry.source}.${entry.signal}`;
            if (!bySignal[key]) bySignal[key] = [];
            bySignal[key].push(entry);
        }
        
        for (const [signal, entries] of Object.entries(bySignal)) {
            console.log(`\n${signal}: ${entries.length} occurrences`);
            for (const entry of entries.slice(0, 5)) {
                console.log(`  - [${entry.elapsed}] Args: ${entry.args}`);
            }
            if (entries.length > 5) {
                console.log(`  ... and ${entries.length - 5} more`);
            }
        }
        
        console.log('\n📈 Timeline:');
        for (const entry of signalLog.slice(0, 20)) {
            console.log(`  [${entry.elapsed}] ${entry.source}.${entry.signal}`);
        }
        if (signalLog.length > 20) {
            console.log(`  ... and ${signalLog.length - 20} more events`);
        }
    }
    
    console.log('\n👋 Exiting...');
    process.exit(0);
});

main().catch(console.error);
