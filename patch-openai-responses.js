/**
 * Build-time patch for openclaw image_url handling.
 *
 * Patches two targets:
 *
 * TARGET 1: openai-responses-shared.js (@mariozechner/pi-ai)
 *   Injects __mcpImageUrl() helper and replaces template literals that construct
 *   image_url from item/block fields.
 *
 * TARGET 2: bundled openclaw dist files (e.g. anthropic-vertex-stream-*.js)
 *   Some bundled files have unpatched:
 *     image_url: `data:${item.mimeType};base64,${item.data}`
 *   which breaks with mcp-bridge Layout D where the item is stripped to {type, text}.
 *
 * Known image content layouts (depending on SDK version and code path):
 *   A. Anthropic SDK wrapped:  { type:"image", source:{type:"base64", data:"...", media_type:"..."} }
 *   B. Raw MCP:                { type:"image", data:"...", mimeType:"..." }
 *   C. URL form:               { type:"image", source:{type:"url", url:"data:image/jpeg;base64,..."} }
 *   D. mcp-bridge stripped:    { type:"image", text:"{\"type\":\"image\",\"data\":\"...\",\"mimeType\":\"...\"}" }
 *      @aiwerk/openclaw-mcp-bridge converts ALL content items to {type, text} only, putting the
 *      original object as JSON.stringify() into `text`. We parse it back to recover the image data.
 */

'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

// =============================================================================
// TARGET 1: openai-responses-shared.js
// =============================================================================

const TARGET =
  '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js';

let code = fs.readFileSync(TARGET, 'utf8');

// ── 1. Prepend the helper function ──────────────────────────────────────────
const HELPER = `
function __mcpImageUrl(blk) {
  var src = blk && blk.source;
  // Layout C: source already contains a complete data URL
  if (src && src.url) return src.url;
  // Pick MIME type from wherever it lives
  var mime = (src && src.media_type) || blk.mimeType || 'image/jpeg';
  // Pick raw data from wherever it lives (layouts A and B)
  var raw = (src && src.data !== undefined) ? src.data : blk.data;
  // Layout D: @aiwerk/openclaw-mcp-bridge strips all fields except {type, text} and puts
  // JSON.stringify(originalItem) into blk.text — parse it back to recover the image data.
  if (raw == null && typeof blk.text === 'string') {
    try {
      var parsed = JSON.parse(blk.text);
      var psrc = parsed.source;
      raw = (psrc && psrc.data !== undefined) ? psrc.data : parsed.data;
      if (!mime || mime === 'image/jpeg') {
        mime = (psrc && psrc.media_type) || parsed.mimeType || 'image/jpeg';
      }
    } catch (e) {}
  }
  if (raw == null) {
    // Log the full block JSON so we can see the exact layout in docker logs
    console.error('[MCP-IMAGE] image data missing. Full block:', JSON.stringify(blk || null));
    return 'data:' + mime + ';base64,MISSING_IMAGE_DATA';
  }
  var b64 = typeof raw === 'string' ? raw : Buffer.from(raw).toString('base64');
  return 'data:' + mime + ';base64,' + b64;
}
`;

code = HELPER + code;

// ── 2. Replace image_url template literals ───────────────────────────────────
// Matches:  image_url: `data:${item. ... ` (anything up to the closing backtick)
const itemBefore = code;
code = code.replace(
  /image_url:\s*`data:\$\{item\.[^`]*`/g,
  'image_url: __mcpImageUrl(item)'
);

const blockBefore = code;
code = code.replace(
  /image_url:\s*`data:\$\{block\.[^`]*`/g,
  'image_url: __mcpImageUrl(block)'
);

// ── 3. Verify at least one substitution happened ─────────────────────────────
const itemChanged = (code !== itemBefore);
const blockChanged = (code !== blockBefore);

if (!itemChanged && !blockChanged) {
  // Fallback: the template literal forms may have been partially patched already.
  // Try matching more broadly.
  const broadBefore = code;
  code = code.replace(
    /image_url:\s*`[^`]*\$\{(?:item|block)[^`]*`/g,
    (match) => {
      const who = match.includes('${item') ? 'item' : 'block';
      return 'image_url: __mcpImageUrl(' + who + ')';
    }
  );
  if (code === broadBefore) {
    console.error('ERROR: No image_url patterns matched — file structure may have changed.');
    console.error('Searching for "image_url" occurrences:');
    code.split('\n').forEach((line, i) => {
      if (line.includes('image_url')) console.error('  line ' + (i+1) + ': ' + line.trim());
    });
    process.exit(1);
  }
  console.log('openai-responses-shared.js patched OK (broad fallback pattern used)');
} else {
  console.log('openai-responses-shared.js patched OK'
    + (itemChanged ? ' [item path]' : '')
    + (blockChanged ? ' [block path]' : ''));
}

fs.writeFileSync(TARGET, code);

// =============================================================================
// TARGET 2: bundled openclaw dist files with bare item.mimeType template literals
// =============================================================================
// Pattern: image_url: `data:${item.mimeType};base64,${item.data}`
// These appear in bundled files (e.g. anthropic-vertex-stream-*.js) and break with
// mcp-bridge Layout D items that are stripped to {type, text}.
// Fix: replace inline with a self-contained IIFE that handles all layouts.

const DIST_DIR = '/usr/lib/node_modules/openclaw/dist';
const INLINE_HELPER =
  `(function(blk){` +
  `var src=blk&&blk.source;` +
  `if(src&&src.url)return src.url;` +
  `var mime=(src&&src.media_type)||blk.mimeType;` +
  `var raw=(src&&src.data!==undefined)?src.data:blk.data;` +
  `if((raw==null||!mime)&&typeof blk.text==='string'){` +
    `try{var p=JSON.parse(blk.text);var ps=p.source;` +
    `raw=raw==null?((ps&&ps.data!==undefined)?ps.data:p.data):raw;` +
    `if(!mime)mime=(ps&&ps.media_type)||p.mimeType;}` +
    `catch(e){}` +
  `}` +
  `return'data:'+(mime||'image/jpeg')+';base64,'+(raw||'');` +
  `})(item)`;

let distFiles = [];
try {
  const result = execSync(
    `grep -rl 'image_url' ${DIST_DIR} 2>/dev/null`,
    { encoding: 'utf8' }
  ).trim();
  distFiles = result
    ? result.split('\n').filter(f => f.endsWith('.js') && !f.endsWith('.map'))
    : [];
} catch (e) {
  distFiles = [];
}

// Matches image_url: `data:${<anyVar>.mimeType};base64,${<sameVar>.data}` with any variable name.
// Capture group 1 is the variable name so the replacement can reference the same variable.
const BARE_PATTERN = /image_url:\s*`data:\$\{(\w+)\.mimeType\};base64,\$\{\1\.data\}`/g;
let distPatched = 0;

for (const file of distFiles) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
  if (!BARE_PATTERN.test(src)) { BARE_PATTERN.lastIndex = 0; continue; }
  BARE_PATTERN.lastIndex = 0;
  // Replace using the captured variable name so the IIFE receives the correct object.
  const patched = src.replace(BARE_PATTERN, (_, varName) =>
    'image_url: ' + INLINE_HELPER.replace(/\(item\)$/, '(' + varName + ')')
  );
  if (patched !== src) {
    fs.writeFileSync(file, patched);
    const short = file.replace(DIST_DIR + '/', '');
    console.log(`Patched bare item.mimeType template in dist/${short}`);
    distPatched++;
  }
}

if (distPatched === 0) {
  console.log('No bare item.mimeType image_url templates found in dist/ (already patched or not present).');
} else {
  console.log(`Patched ${distPatched} dist file(s) for mcp-bridge Layout D image support.`);
}
