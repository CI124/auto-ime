#!/usr/bin/env node
/**
 * Fcitx5 /controller 路径深度诊断 — 结果写入文件
 */
const dbus = require('dbus-next');
const fs = require('fs');
const path = require('path');

const outFile = path.join(__dirname, '..', 'dbus-diag-result.txt');
const lines = [];

function log(msg) {
    lines.push(msg);
    console.log(msg);
}

async function main() {
    const bus = dbus.sessionBus();
    log('=== Fcitx5 /controller 深度诊断 ===\n');

    // 1. Introspect /controller
    try {
        const obj = await bus.getProxyObject('org.fcitx.Fcitx5', '/controller');
        const intro = obj.getInterface('org.freedesktop.DBus.Introspectable');
        const xml = await intro.Introspect();
        log('--- /controller Introspect XML ---');
        log(xml);
    } catch (e) {
        log('无法 introspect /controller: ' + e.message);
    }

    // 2. 列出接口
    try {
        const obj = await bus.getProxyObject('org.fcitx.Fcitx5', '/controller');
        log('\n--- /controller 接口列表 ---');
        for (const iface of obj.interfaces) {
            log(`\n接口: ${iface.name}`);
            if (iface.methods && Object.keys(iface.methods).length) {
                log('  方法: ' + Object.keys(iface.methods).join(', '));
            }
            if (iface.signals && Object.keys(iface.signals).length) {
                log('  信号: ' + Object.keys(iface.signals).join(', '));
            }
            if (iface.properties && Object.keys(iface.properties).length) {
                log('  属性: ' + Object.keys(iface.properties).join(', '));
            }
        }
    } catch (e) {
        log('列出接口失败: ' + e.message);
    }

    // 3. 也检查 /inputmethod 不存在的原因
    log('\n--- 检查所有 Fcitx5 对象路径 ---');
    try {
        const rootObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/');
        const intro = rootObj.getInterface('org.freedesktop.DBus.Introspectable');
        const xml = await intro.Introspect();
        log('根路径 Introspect:');
        log(xml);
    } catch (e) {
        log('根路径 introspect 失败: ' + e.message);
    }

    // 4. 检查 org 子路径
    try {
        const orgObj = await bus.getProxyObject('org.fcitx.Fcitx5', '/org');
        const intro = orgObj.getInterface('org.freedesktop.DBus.Introspectable');
        const xml = await intro.Introspect();
        log('\n/org Introspect:');
        log(xml);
    } catch (e) {
        log('/org introspect 失败: ' + e.message);
    }

    // 5. 检查 fcitx5-remote -n 输出
    log('\n--- fcitx5-remote 状态 ---');
    try {
        const { execSync } = require('child_process');
        const name = execSync('fcitx5-remote -n', { encoding: 'utf-8', timeout: 1000 }).trim();
        const state = execSync('fcitx5-remote', { encoding: 'utf-8', timeout: 1000 }).trim();
        log(`fcitx5-remote -n: "${name}"`);
        log(`fcitx5-remote: "${state}" (1=inactive/English, 2=active/Chinese)`);
    } catch (e) {
        log('fcitx5-remote 失败: ' + e.message);
    }

    // 6. 检查 fcitx5 版本
    try {
        const { execSync } = require('child_process');
        const ver = execSync('fcitx5 --version 2>&1 || true', { encoding: 'utf-8', timeout: 1000 }).trim();
        log(`fcitx5 版本: ${ver}`);
    } catch {}

    // 写入文件
    fs.writeFileSync(outFile, lines.join('\n'), 'utf-8');
    log(`\n结果已写入: ${outFile}`);
}

main().catch(e => {
    log('ERROR: ' + e.message);
    fs.writeFileSync(outFile, lines.join('\n'), 'utf-8');
    process.exit(1);
});
