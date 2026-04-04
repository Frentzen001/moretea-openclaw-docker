/**
 * Build-time patch for openai-responses-shared.js (@mariozechner/pi-ai).
 *
 * Approach: inject a __mcpImageUrl() helper that handles every known layout of
 * a wrapped MCP ImageContent block, then replace the image_url template literals
 * with calls to that helper. This avoids brittle template-expression substitution.
 *
 * Known layouts (depending on SDK version and code path):
 *   A. Anthropic SDK wrapped:  { type:"image", source:{type:"base64", data:"...", media_type:"..."} }
 *   B. Raw MCP:                { type:"image", data:"...", mimeType:"..." }
 *   C. URL form:               { type:"image", source:{type:"url", url:"data:image/jpeg;base64,..."} }
 *   D. mcp-bridge stripped:    { type:"image", text:"{\"type\":\"image\",\"data\":\"...\",\"mimeType\":\"...\"}" }
 *      @aiwerk/openclaw-mcp-bridge converts ALL content items to {type, text} only, putting the
 *      original object as JSON.stringify() into `text`. We parse it back to recover the image data.
 */

'use strict';
const fs = require('fs');

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
    // Log the full block so we can see the real structure in docker logs
    console.error('[MCP-IMAGE] image data missing. block keys:', Object.keys(blk || {}),
      '| source:', JSON.stringify(src || null));
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
