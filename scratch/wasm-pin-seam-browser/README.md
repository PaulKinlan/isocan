# The browser leg of the wasm pin seam — out-of-suite drive, 19 Sep 2026

The suite (`packages/server/test/wasm-pin-seam.test.ts`) proves the pin seam
against Node. The BROWSER leg — Chrome's own fetch stack, `crypto.subtle` and
wasm engine, against the same pinned bytes — was driven out-of-suite, per the
house rule: drive a real browser and SAY SO in the report.

Apparatus, reproducible by any lane:

1. `npx vite-node scratch/wasm-pin-seam-browser/seed-daemon.mjs` — starts a
   real daemon on a temp home, creates the project, uploads the good module
   and its tampered twin (byte 39, i32.add→i32.sub), sets
   `tools.pins.add` via a real `project.update` op, prints
   `{ base, canvasId, good, tampered }`, and stays alive.
2. Open a real Chrome page on the printed `base` (any same-origin document),
   then from PAGE CONTEXT:
   - `POST /api/door {"carrier":"cookie"}` with `credentials:"include"` —
     the HttpOnly badge cookie is set by Set-Cookie; the body carries no
     secret (DoorResponse.secret is bearer-only).
   - `GET /api/projects/:id/canvas` → `project.properties["tools.pins.add"]`
     is the pin.
   - `GET /api/projects/:id/blobs/<hash>` → bytes;
     `crypto.subtle.digest("SHA-256")` must equal the pin BEFORE
     `WebAssembly.instantiate`; run `exports.add(2,3)`.
   - Repeat with the tampered hash: the verifier must refuse before
     instantiate.

Observed 19 Sep 2026, HeadlessChrome/152 (Linux), daemon at 127.0.0.1:35673:
pin resolved true; good bytes `add(2,3)=5`, `add(20,22)=42` — identical to
Node; tampered REFUSED `digest mismatch: pinned f61fd62f57c4…, bytes hash
51851cf8e541…`. Screenshot in the journal session transcript; drive script
recorded in the journal entry of 19 Sep.

Not covered by any CI assertion: the in-suite browser leg needs a browser
dependency (puppeteer/playwright) in the repo — a dependency decision, not
part of this fixture.
