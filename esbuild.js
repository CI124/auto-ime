const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const outDir = path.join(__dirname, 'dist');

async function build() {
    // Ensure output directory exists
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    // Copy AST language WASM files to dist/wasm/
    const wasmSrc = path.join(__dirname, 'wasm');
    const wasmDest = path.join(outDir, 'wasm');
    if (fs.existsSync(wasmSrc)) {
        fs.cpSync(wasmSrc, wasmDest, { recursive: true });
        console.log('[Build] Copied language wasm files to dist/wasm/');
    }

    // Copy web-tree-sitter core tree-sitter.wasm to dist/
    const coreWasmSrc = path.join(__dirname, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
    if (fs.existsSync(coreWasmSrc)) {
        fs.copyFileSync(coreWasmSrc, path.join(outDir, 'tree-sitter.wasm'));
        console.log('[Build] Copied core tree-sitter.wasm to dist/');
    }

    const buildOptions = {
        entryPoints: ['src/extension.ts'],
        bundle: true,
        outfile: 'dist/extension.js',
        external: ['vscode', 'x11', 'koffi', 'debug'],
        format: 'cjs',
        platform: 'node',
        target: 'node16',
        sourcemap: true,
    };

    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('[Watch] Watching for file changes...');
    } else {
        await esbuild.build(buildOptions);
        console.log('[Build] Build complete.');
    }
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
