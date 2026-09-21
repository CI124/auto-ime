/**
 * scripts/wasm-manifest.js
 *
 * Tree-sitter 语言 WASM 的唯一清单元数据（文件名 → 期望 SHA-256 + 下载地址）。
 *
 * 为什么要单独成模块：`download-wasm.js`（postinstall 下载）与 `verify-wasm.js`
 * （CI 完整性门禁）必须使用【同一份】校验和；任何一份漂移都会让「下载通过、
 * 门禁失败」或反之。新增语言时只改这里。
 *
 * 来源：https://unpkg.com/tree-sitter-wasms@0.1.11/out/ （固定版本，避免上游
 * 重新发布同名产物导致哈希漂移）。
 */

'use strict';

const BASE_HOST = 'unpkg.com';
const BASE_URL = `https://${BASE_HOST}/tree-sitter-wasms@0.1.11/out/`;

const CHECKSUMS = {
  'tree-sitter-bash.wasm': '807dcdb1380a59befb112ed8fbd3d3872c7fadaf5903a769282b50973b30696d',
  'tree-sitter-c.wasm': '056b25072382f72deee2c64ec238ffc4bb8cf42844ef21502c0e70f03a8a0d66',
  'tree-sitter-cpp.wasm': 'f6afdf53bfd6de76557bb7edb624a3a3869e14d9a83b78433f93617ecee42527',
  'tree-sitter-css.wasm': '5fc615467b1b98420ed7517e5bf9e1f88468132dd903d842dfb13714f6a1cb0c',
  'tree-sitter-go.wasm': '9963ca89b616eaf04b08a43bc1fb0f07b85395bec313330851f1f1ead2f755b6',
  'tree-sitter-html.wasm': '89a9e394e25d576a042ca0c4ebc50ff79b200348fb1eae2f9496f03a04c941c0',
  'tree-sitter-java.wasm': '637aac4415fb39a211a4f4292d63c66b5ce9c32fa2cd35464af4f681d91b9a1f',
  'tree-sitter-javascript.wasm': '1c99d4b953d2543bd6b934eb7206118fb732b473cd725ba04f258163b2bd3253',
  'tree-sitter-kotlin.wasm': 'b9ce86bfbafe55bce867bb5df035916a81e67453a8d803a3735b9bd352c4d023',
  'tree-sitter-lua.wasm': '75ef809136d610068c5b2135741d89f5df62690a3d55169203351cb7cc85727d',
  'tree-sitter-python.wasm': '9056d0fb0c337810d019fae350e8167786119da98f0f282aceae7ab89ee8253b',
  'tree-sitter-rust.wasm': '4409921a70d0aa5bec7d1d7ce809a557a8ee1cf6ace901e3ac6a76e62cfea903',
  'tree-sitter-typescript.wasm': '8515404dceed38e1ed86aa34b09fcf3379fff1b4ff9dd3967bcd6d1eb5ac3d8f',
};

module.exports = { BASE_HOST, BASE_URL, CHECKSUMS, FILE_NAMES: Object.keys(CHECKSUMS) };
