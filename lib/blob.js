// Blob abstraction: Vercel Blob when BLOB_READ_WRITE_TOKEN is set,
// otherwise writes to public/assets/. Returns the public URL.
const fs = require('fs');
const path = require('path');

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
let blobLib;
if (useBlob) {
  try { blobLib = require('@vercel/blob'); }
  catch (e) { console.warn('@vercel/blob not available:', e.message); }
}

const ASSETS_DIR = path.join(process.cwd(), 'public', 'assets');

/**
 * Upload an asset and return its public URL.
 * Old files with the same prefix are cleaned up first.
 * @param {object} opts
 * @param {Buffer} opts.buf - file content
 * @param {string} opts.ext - file extension (no dot)
 * @param {string} opts.prefix - eg 'profile', 'sound', 'alert'
 * @param {string} [opts.mime] - mime type (Vercel Blob only)
 */
async function uploadAsset({ buf, ext, prefix, mime }) {
  const filename = `${prefix}-${Date.now()}.${ext}`;

  if (useBlob && blobLib) {
    // Delete previous blobs with this prefix
    try {
      const { blobs } = await blobLib.list({ prefix });
      for (const b of blobs) {
        if (b.pathname.startsWith(prefix + '-')) {
          try { await blobLib.del(b.url); } catch {}
        }
      }
    } catch {}
    const result = await blobLib.put(filename, buf, {
      access: 'public',
      contentType: mime,
      addRandomSuffix: false
    });
    return result.url;
  }

  // Local: write to public/assets and return relative URL
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const re = new RegExp(`^${prefix}-\\d+\\.`, 'i');
  for (const f of fs.readdirSync(ASSETS_DIR)) {
    if (re.test(f)) try { fs.unlinkSync(path.join(ASSETS_DIR, f)); } catch {}
  }
  fs.writeFileSync(path.join(ASSETS_DIR, filename), buf);
  return '/assets/' + filename;
}

/**
 * Delete asset(s) by URL or by prefix.
 */
async function deleteAsset(urlOrPrefix) {
  if (useBlob && blobLib) {
    try { await blobLib.del(urlOrPrefix); } catch {}
    return;
  }
  // Local: only handle URLs starting with /assets/
  if (typeof urlOrPrefix === 'string' && urlOrPrefix.startsWith('/assets/')) {
    const file = path.join(ASSETS_DIR, path.basename(urlOrPrefix));
    try { fs.unlinkSync(file); } catch {}
  }
}

module.exports = { uploadAsset, deleteAsset, useBlob };
