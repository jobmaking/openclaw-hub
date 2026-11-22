# PDF.js 6.5.438 (Apache-2.0)

Locally hosted, unmodified PDF.js legacy distribution files from the official Mozilla package:
https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz

Package SHA-512 (npm SRI): `sha512-vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA==`.

Copied `legacy/build/pdf.min.mjs`, `legacy/build/pdf.worker.min.mjs`, `LICENSE`, and renderer resources (`cmaps`, `iccs`, `standard_fonts` and `wasm` including their notices). Excluded the browser viewer, source maps, sandbox, JavaScript scripting engine (`quickjs-eval.*`) and all dependencies for Node builds. Each included original is pinned in `SHA256SUMS`. Recheck with `sha256sum -c SHA256SUMS` from this directory. Updates must use a new versioned path and pass the viewer checks, including with the worker CSP in effect.
