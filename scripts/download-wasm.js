const https = require('https');
const fs = require('fs');
const path = require('path');

const WASM_DIR = path.join(__dirname, '..', 'wasm');
const BASE_URL = 'https://unpkg.com/tree-sitter-wasms@0.1.11/out/';

const LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'c',
  'cpp',
  'go',
  'rust',
  'html',
  'css',
  'lua',
  'java',
  'kotlin',
  'bash'
];

if (!fs.existsSync(WASM_DIR)) {
  fs.mkdirSync(WASM_DIR, { recursive: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle redirect
        download(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
      }

      const file = fs.createWriteStream(dest);
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function main() {
  console.log('Downloading tree-sitter wasm files...');
  for (const lang of LANGUAGES) {
    const filename = `tree-sitter-${lang}.wasm`;
    const dest = path.join(WASM_DIR, filename);
    
    if (fs.existsSync(dest)) {
      console.log(`[SKIP] ${filename} already exists.`);
      continue;
    }

    try {
      console.log(`[DOWNLOAD] fetching ${filename}...`);
      await download(`${BASE_URL}${filename}`, dest);
      console.log(`[SUCCESS] ${filename} downloaded.`);
    } catch (err) {
      console.error(`[ERROR] Failed to download ${filename}:`, err.message);
    }
  }
}

main();