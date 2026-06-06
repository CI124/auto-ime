/**
 * D-Bus 信号监听测试脚本
 * 
 * 用于验证 Fcitx5/IBus 的 D-Bus 信号：
 * 1. 哪些信号会被触发
 * 2. 信号的参数是什么
 * 3. 信号的时序和频率
 * 
 * 用法: node test/dbus-signal-test.js
 * 
 * 测试步骤：
 * 1. 运行脚本
 * 2. 手动切换输入法（Ctrl+Space、系统托盘等）
 * 3. 观察控制台输出的信号
 * 4. 按 Ctrl+C 停止
 */

const dbus = require('dbus-next');

// 信号记录
const signalLog = [];
let signalCount = 0;

function logSignal(source, signalName, args, timestamp) {
    signalCount++;
    const entry = {
        id: signalCount,
        source,
        signal: signalName,
        args: args ? JSON.stringify(args) : '(none)',
        timestamp: timestamp || new Date().toISOString(),
        relativeTime: Date.now(),
    };
    signalLog.push(entry);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${entry.id}] ${source} → ${signalName}`);
    console.log(`    Args: ${entry.args}`);
    console.log(`    Time: ${entry.timestamp}`);
    console.log(`${'='.repeat(60)}`);
}

// 检测 Fcitx5
async function testFcitx5() {
    console.log('\n🔍 Testing Fcitx5 D-Bus signals...\n');
    
    try {
        const bus = dbus.sessionBus();
        
        // 1. 获取 InputMethod1 接口
        console.log('📡 Connecting to org.fcitx.Fcitx5 /inputmethod...');
        let inputMethodObj;
        try {
            inputMethodObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/inputmethod');
            console.log('✅ Found /inputmethod');
        } catch (e) {
            console.log('❌ /inputmethod not found:', e.message);
            return false;
        }
        
        const inputMethodIface = inputMethodObj.getInterface('org.fcitx.Fcitx.InputMethod1');
        if (!inputMethodIface) {
            console.log('❌ InputMethod1 interface not found');
            return false;
        }
        
        // 2. 创建 InputContext
        console.log('📡 Creating InputContext...');
        let contextPath;
        try {
            contextPath = await inputMethodIface.CreateInputContext('auto-ime-test', 'test-script');
            console.log(`✅ InputContext created: ${contextPath}`);
        } catch (e) {
            console.log('❌ CreateInputContext failed:', e.message);
            return false;
        }
        
        // 3. 获取 InputContext 对象
        console.log('📡 Getting InputContext object...');
        let contextObj;
        try {
            contextObj = await bus.getProxyObject('org.fcitx.Fcitx5', contextPath);
            console.log('✅ InputContext object obtained');
        } catch (e) {
            console.log('❌ Failed to get InputContext:', e.message);
            return false;
        }
        
        // 4. Introspect 信号
        console.log('\n📡 Introspecting InputContext signals...');
        try {
            const introspectable = contextObj.getInterface('org.freedesktop.DBus.Introspectable');
            const xml = await introspectable.Introspect();
            const signals = [...xml.matchAll(/<signal name="([^"]+)">/g)].map(m => m[1]);
            console.log(`✅ Available signals: [${signals.join(', ')}]`);
        } catch (e) {
            console.log('⚠️  Introspection failed:', e.message);
        }
        
        // 5. 监听 InputContext1 上的信号
        console.log('\n📡 Setting up signal listeners...');
        const ctxIface = contextObj.getInterface('org.fcitx.Fcitx.InputContext1');
        if (ctxIface) {
            // CurrentIM 信号
            ctxIface.on('CurrentIM', (uniqueName, name, langCode) => {
                logSignal('InputContext1', 'CurrentIM', { uniqueName, name, langCode });
            });
            console.log('✅ Listening for CurrentIM');
            
            // StatusChanged 信号
            ctxIface.on('StatusChanged', (...args) => {
                logSignal('InputContext1', 'StatusChanged', args);
            });
            console.log('✅ Listening for StatusChanged');
            
            // CommitString 信号
            ctxIface.on('CommitString', (...args) => {
                logSignal('InputContext1', 'CommitString', args);
            });
            console.log('✅ Listening for CommitString');
            
            // ForwardKey 信号
            ctxIface.on('ForwardKey', (...args) => {
                logSignal('InputContext1', 'ForwardKey', args);
            });
            console.log('✅ Listening for ForwardKey');
        } else {
            console.log('❌ InputContext1 interface not found');
        }
        
        // 6. 监听 /controller 上的信号
        console.log('\n📡 Setting up /controller listeners...');
        try {
            const controllerObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/controller');
            const controllerIface = controllerObj.getInterface('org.fcitx.Fcitx5.Controller1');
            if (controllerIface) {
                // InputMethodChanged 信号
                controllerIface.on('InputMethodChanged', (...args) => {
                    logSignal('Controller1', 'InputMethodChanged', args);
                });
                console.log('✅ Listening for InputMethodChanged');
                
                // IMStateChanged 信号
                controllerIface.on('IMStateChanged', (...args) => {
                    logSignal('Controller1', 'IMStateChanged', args);
                });
                console.log('✅ Listening for IMStateChanged');
            }
        } catch (e) {
            console.log('⚠️  /controller not available:', e.message);
        }
        
        // 7. PropertiesChanged 兜底
        console.log('\n📡 Setting up PropertiesChanged listener...');
        try {
            const matchRule = [
                `type='signal'`,
                `interface='org.freedesktop.DBus.Properties'`,
                `member='PropertiesChanged'`,
                `path='${contextPath}'`,
            ].join(',');
            
            const dbusObj = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
            const dbusIface = dbusObj.getInterface('org.freedesktop.DBus');
            if (dbusIface) {
                await dbusIface.AddMatch(matchRule);
                console.log('✅ PropertiesChanged match added');
            }
            
            if (typeof bus.on === 'function') {
                bus.on('message', (msg) => {
                    if (msg.interface === 'org.freedesktop.DBus.Properties' &&
                        msg.member === 'PropertiesChanged' &&
                        msg.path === contextPath) {
                        logSignal('Properties', 'PropertiesChanged', msg.body);
                    }
                });
                console.log('✅ Listening for PropertiesChanged on bus');
            }
        } catch (e) {
            console.log('⚠️  PropertiesChanged setup failed:', e.message);
        }
        
        return true;
    } catch (e) {
        console.log('❌ Fcitx5 test failed:', e.message);
        return false;
    }
}

// 检测 IBus
async function testIBus() {
    console.log('\n🔍 Testing IBus D-Bus signals...\n');
    
    try {
        const bus = dbus.sessionBus();
        
        // 监听 GlobalEngineChanged 信号
        console.log('📡 Connecting to org.freedesktop.IBus...');
        let ibusObj;
        try {
            ibusObj = await bus.getProxyObject('org.freedesktop.IBus', '/org/freedesktop/IBus');
            console.log('✅ Found IBus object');
        } catch (e) {
            console.log('❌ IBus not found:', e.message);
            return false;
        }
        
        const ibusIface = ibusObj.getInterface('org.freedesktop.IBus');
        if (ibusIface) {
            // GlobalEngineChanged 信号
            ibusIface.on('GlobalEngineChanged', (engineName) => {
                logSignal('IBus', 'GlobalEngineChanged', { engineName });
            });
            console.log('✅ Listening for GlobalEngineChanged');
            
            // GlobalEngineSet 信号
            ibusIface.on('GlobalEngineSet', (engineName) => {
                logSignal('IBus', 'GlobalEngineSet', { engineName });
            });
            console.log('✅ Listening for GlobalEngineSet');
        }
        
        return true;
    } catch (e) {
        console.log('❌ IBus test failed:', e.message);
        return false;
    }
}

// 主函数
async function main() {
    console.log('🚀 D-Bus Signal Test Script');
    console.log('===========================\n');
    console.log('This script will listen for D-Bus signals from Fcitx5/IBus.');
    console.log('Please switch input methods manually and observe the output.');
    console.log('Press Ctrl+C to stop.\n');
    
    // 检测并测试 Fcitx5
    const fcitx5Available = await testFcitx5();
    
    // 检测并测试 IBus
    const ibusAvailable = await testIBus();
    
    if (!fcitx5Available && !ibusAvailable) {
        console.log('\n❌ Neither Fcitx5 nor IBus detected. Exiting.');
        process.exit(1);
    }
    
    console.log('\n✅ Listening for signals... (switch input methods to test)');
    console.log('   - Try Ctrl+Space to toggle IME on/off');
    console.log('   - Try switching between input methods');
    console.log('   - Try using system tray to switch\n');
    
    // 定期显示统计信息
    setInterval(() => {
        if (signalLog.length > 0) {
            console.log(`\n📊 Total signals received: ${signalLog.length}`);
        }
    }, 10000);
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
            for (const entry of entries.slice(0, 3)) {  // 只显示前3个
                console.log(`  - Args: ${entry.args}`);
            }
            if (entries.length > 3) {
                console.log(`  ... and ${entries.length - 3} more`);
            }
        }
    }
    
    console.log('\n👋 Exiting...');
    process.exit(0);
});

// 运行
main().catch(console.error);
