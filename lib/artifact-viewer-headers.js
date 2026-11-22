'use strict';
const path = require('node:path');

function artifactViewerHeaders(res, filename) {
  const dir = path.resolve(__dirname, '../public/vendor/pdfjs-6.5.438') + path.sep;
  if (!filename.startsWith(dir)) return;
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (filename === dir + 'pdf.worker.min.mjs') {
    // The Hub brokers only the packaged font/decoder requests. The worker has no network API access.
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'");
  }
}
module.exports={artifactViewerHeaders};
