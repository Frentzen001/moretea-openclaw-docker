/**
 * Build-time patch for openai-responses-shared.js (@mariozechner/pi-ai).
 *
 * Root cause: the Anthropic SDK mcpContent() helper wraps MCP ImageContent from
 *   { type:"image", data:"<b64>", mimeType:"image/jpeg" }
 * into
 *   { type:"image", source:{ type:"base64", data:"<b64>", media_type:"image/jpeg" } }
 *
 * So item/block.data and item/block.mimeType are undefined at the call sites in
 * openai-responses-shared.js; the actual values live at .source.data / .source.media_type.
 * This script patches those two lines so they fall back to the nested source object first.
 */

'use strict';
const fs = require('fs');

const TARGET =
  '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js';

let code = fs.readFileSync(TARGET, 'utf8');
const before = code;

// 1. Fix mimeType references (handles both with and without || "image/jpeg" fallback)
code = code.replace(
  /\$\{item\.mimeType(\s*\|\|\s*"image\/jpeg")?\}/g,
  '${item.source?.media_type || item.mimeType || "image/jpeg"}'
);
code = code.replace(
  /\$\{block\.mimeType(\s*\|\|\s*"image\/jpeg")?\}/g,
  '${block.source?.media_type || block.mimeType || "image/jpeg"}'
);

// 2. Fix data references — simple ${x.data} form
code = code.replace(
  /\$\{item\.data\}/g,
  '${typeof (item.source?.data||item.data)==="string"?(item.source?.data||item.data):Buffer.from(item.source?.data||item.data).toString("base64")}'
);
code = code.replace(
  /\$\{block\.data\}/g,
  '${typeof (block.source?.data||block.data)==="string"?(block.source?.data||block.data):Buffer.from(block.source?.data||block.data).toString("base64")}'
);

// 3. Fix data references — typeof guard form (in case a prior partial patch applied)
code = code.replace(
  /typeof item\.data==="string"\?item\.data:Buffer\.from\(item\.data\)\.toString\("base64"\)/g,
  'typeof (item.source?.data||item.data)==="string"?(item.source?.data||item.data):Buffer.from(item.source?.data||item.data).toString("base64")'
);
code = code.replace(
  /typeof block\.data==="string"\?block\.data:Buffer\.from\(block\.data\)\.toString\("base64"\)/g,
  'typeof (block.source?.data||block.data)==="string"?(block.source?.data||block.data):Buffer.from(block.source?.data||block.data).toString("base64")'
);

if (code === before) {
  console.error('ERROR: No patterns matched — file may have changed. Aborting.');
  process.exit(1);
}

fs.writeFileSync(TARGET, code);
console.log('openai-responses-shared.js patched OK');
