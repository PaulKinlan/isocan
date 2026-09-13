# Voice page → `packages/voice-agent`: the extraction plan

**Status: preparation only.** Nothing has been moved, and no page file has been
edited — astra owns `packages/web/src/voice/`, `voice.html` and the voice block
in `styles.css` until its cog/mobile work lands. This document is the map that
makes the move a move.

Written against `feat/voice-ui-vite` @ `bf0acf17`, with the integration branch
(`feat/voice-agent`) noted where it differs — it carries one thing this branch
does not: the `define: { __VOICE_BUILD_INFO__ }` block in
`packages/web/vite.config.ts`.

The destination is Paul's: **`packages/voice-agent`**, its own workspace
package.

---

## 1. The dependency map

### 1.1 What is actually the voice page

| File | Lines | What it needs | Voice-only or shared? |
| --- | --- | --- | --- |
| `packages/web/voice.html` | 175 | `/src/voice/main.ts` (module script), `/icon.svg` from `public/` | voice-only |
| `packages/web/src/voice/main.ts` | 1,356 | `../styles.css`, `../lib/voice.ts`, `../lib/voiceAudio.ts` | voice-only |
| `packages/web/src/lib/voice.ts` | 170 | browser globals only (fetch, WebSocket) — **no imports at all** | voice-only |
| `packages/web/src/lib/voiceAudio.ts` | 401 | browser globals only — **no imports at all** | voice-only |
| `packages/web/src/styles.css` | 6,876 | — | **95% app CSS; the voice block is lines 6396–6876** |
| `packages/web/test/voicemeter.test.ts` | 79 | `../src/lib/voiceAudio.ts` | voice-only |
| `packages/web/test/voiceresample.test.ts` | 103 | `../src/lib/voiceAudio.ts` | voice-only |
| `packages/web/test/voiceplayback.test.ts` | 116 | `../src/lib/voiceAudio.ts` | voice-only |
| `packages/web/test/voicepage.test.ts` | 623 | `../src/lib/voice.ts`, `../src/voice/main.ts`, **and `packages/web/voice.html` read from `process.cwd()`** (`:21`) | voice-only, with one path trap |

Nothing else in `packages/web` imports any of these: `grep -rn "lib/voice"
packages/web/src packages/web/test` answers only the four test files and the
page itself. There is **no React, no zustand, no router, no `@isocan/*` import**
anywhere in the page's graph. The page is already framework-free; the coupling
is not React, and it is not a store.

### 1.2 The coupling that does exist: the app stylesheet

`src/voice/main.ts:15` — `import "../styles.css"` — pulls in the **entire**
6,876-line application stylesheet to get:

  - **the voice block**, lines 6396–6876: 481 lines, 423 declarations (the
    comment at the top plus every `.voice*` rule);
  - **15 CSS custom properties by reference**, all defined in the app's `:root`:
    `--ink`, `--ink-muted`, `--card`, `--line`, `--line-soft`, `--accent`,
    `--accent-text`, `--good`, `--warn`, `--danger`, `--radius` (the other two,
    `--t-*`/`--s*`, are declared inside `.voice` itself);
  - **element-level rules the page never declares and silently relies on**:
    `body { margin: 0; font: 14px/1.5 Inter, system-ui, …; color: var(--ink);
    background: var(--ground) }` (`styles.css:318–331`, which also carries
    `button { font: inherit; cursor: pointer }` and
    `input, textarea { font: inherit; color: var(--ink) }`).

So the stylesheet is **genuinely shared** for tokens and base element rules,
and **happens to live there** for everything else. The extraction should take
copies of the first and none of the second — see §5.

### 1.3 Config the page depends on, and where it lives

| Thing | Where | Moves? |
| --- | --- | --- |
| `voiceEntry` middleware (`/voice` → `/voice.html`) | `packages/web/vite.config.ts:19–34` (comment `:4–18`) | yes — it IS the page's serve path |
| `/harness` dev proxy → `127.0.0.1:7654` (`ws: true`) | `packages/web/vite.config.ts` | yes, to whichever server serves the page |
| `/api` proxy → the daemon | same file | no — that is the app's |
| `define: __VOICE_BUILD_INFO__` (branch + commit) | **integration branch only** | yes — the tag is the page's own claim about itself |
| `@vitejs/plugin-react` | same file | no — the page must stop sharing it (§2.1) |
| tsconfig (`jsx: react-jsx`, `types: ["vite/client"]`) | `packages/web/tsconfig.json` | replaced by the package's own |
| vitest `include: packages/*/test/**` + `setupFiles: test/setup.ts` + `globalSetup: test/emulator.ts` | root `vitest.config.ts` | a decision, not a move: see §2.3 |
| workspace globs `["packages/*", "packages/modules/*"]` | root `package.json` | already covers the new package — **no root edit needed** |
| `/icon.svg` | `packages/web/public/icon.svg` | copy, or drop the `<link rel="icon">` |

---

## 2. What `standalone` has to mean, and what stands in the way

### 2.1 No React imports even transitively

**Already true of the page's own graph** — verified by grep: `main.ts` imports
a stylesheet and two import-free modules, and neither test nor source reaches
React. What is *not* standalone is the **toolchain**: the page is compiled by a
config carrying `@vitejs/plugin-react`, and type-checked by a config with
`jsx: "react-jsx"` and React types in scope. Both go away with the package.
The one React-adjacent assumption is `styles.css` itself, which is fine (CSS
cannot import React) but is 6,420 lines of app rules the page does not use.

### 2.2 Its own Vite config and build

Two blockers, both real:

  1. **The page has no production build today.** It is deliberately not in the
     app's `build.rollupOptions.input` (the argument at
     `packages/web/vite.config.ts:13–17` explains why: a second Rollup entry
     split the app's first-visit chunk, and `cursorart.test.ts` caught it).
     `packages/web/dist/` contains `index.html`, `assets/`, fonts, grounds,
     `sw.js` — **no `voice.html`**. The page is dev-served only, and the
     harness ships its own page separately. The new package's `vite build` must
     therefore emit its own `dist/`, and the rollup-input reasoning above
     *inverts* there — inside `voice-agent`, the page IS the build.
  2. **The proxy and the plugin**, which are the page's dev path, live in the
     app's config. They move; the app's `/api` proxy and React plugin do not.

### 2.3 Its own test scope

The root config's include glob is `packages/*/test/**/*.test.ts`, so a new
`packages/voice-agent/test/` is **picked up automatically** — and with it the
root `setupFiles` (`test/setup.ts`: daemon guard, replica home) and
`globalSetup` (`test/emulator.ts`: Firestore tiers). For four pure tests that
want a DOM and a stub, that is a heavy inheritance and a new way for the app's
infrastructure to break the page's tests. Recommendation — **confirmed by
coord, 2026-09-13** — give the package its own `vitest.config.ts` (jsdom
environment, no setup files) **and** keep the root include glob working; the
root run then exercises the package through the same command, while
`-w @isocan/voice-agent test` runs it alone and fast.

The blockers to name:
  - `voicepage.test.ts:21` resolves `packages/web/voice.html` through
    `process.cwd()`. After the move that path is wrong from the repo root and
    right from nowhere — this is the single most likely mover's trap.
  - `voicepage.test.ts` carries `// @vitest-environment jsdom`; `jsdom@^30` is
    a root devDependency and must be declared by the package (or stay root).

### 2.4 Its own serve path, with `:5199/voice` still working from the new home

This is the only genuinely open design question, because the page uses
**absolute module paths** (`/src/voice/main.ts`) and an HMR websocket, and it
talks to the harness through `/harness` on its own origin.

**Option A — the voice package owns a dev server, and `:5199` redirects to it.**
`packages/voice-agent` runs Vite on its own port (say `:5200`), with its own
`/harness` proxy; the app's server keeps a one-line redirect from `/voice` to
`:5200/voice`. The acceptance URL still works, the page's origin is the server
that serves it, HMR and the audio socket stay same-origin, and no `base`-path
gymnastics are needed. Cost: the URL visibly changes to `:5200`, and two dev
servers must be running (which the integration setup already does for other
reasons).

**Option B — one server, prefixed.** The voice package's config sets
`base: "/voice/"`, its HTML references `/voice/src/main.ts`, and the app's
server proxies `/voice/*` → `:5200/*`. URL never changes; the cost is that
every asset and module path is base-prefixed, the proxy has to carry the HMR
websocket too, and a mistake in the prefix silently 404s modules. More
machinery for a cosmetic URL.

**Recommendation: A**, with the redirect as the acceptance path — it satisfies
"`:5199/voice` still working" without teaching the page to live under a prefix,
and it is the option that best matches "a web-app failure cannot become a
voice-page failure": the app's server can be down and `:5200/voice` still
serves.

> **Confirmed by coord, 2026-09-13: option A.** Same-origin is not a
> convenience here — it is what keeps the audio socket alive through HMR, and
> option B's silent-404 failure mode is the shape of bug this project keeps
excavating.

Either way, `/harness` must exist **on the origin that serves the page**, or
the page loses its harness and its audio socket at once.

---

## 3. The target tree

```
packages/voice-agent/
  package.json          @isocan/voice-agent, private, type: module
                        scripts: dev (vite), build (vite build), typecheck (tsc --noEmit), test (vitest run)
                        devDeps: vite, vitest, jsdom          [no @vitejs/plugin-react, no react]
  vite.config.ts        port 5200 · /harness proxy (ws) · voiceEntry rewrite · __VOICE_BUILD_INFO__
                        define · base "/" (option A) · no react plugin
  tsconfig.json         extends ../../tsconfig.base.json · lib ES2023+DOM+DOM.Iterable ·
                        types ["vite/client"] · include ["src", "test", "vite.config.ts"] · no jsx
  vitest.config.ts      environment jsdom for the page test, node for the DSP tests; no root setupFiles
  voice.html            was packages/web/voice.html
  public/icon.svg       copied (or the <link> dropped)
  src/main.ts           was packages/web/src/voice/main.ts          (import path: ../styles.css → ./voice.css)
  src/voice.ts          was packages/web/src/lib/voice.ts
  src/voiceAudio.ts     was packages/web/src/lib/voiceAudio.ts
  src/voice.css         NEW — see §5: tokens + base element rules + the voice block
  test/voicemeter.test.ts, voiceresample.test.ts, voiceplayback.test.ts, voicepage.test.ts
```

**What `packages/web` loses:** the four test files; `src/voice/`;
`src/lib/voice*.ts`; `styles.css` lines 6396–6876 (481 lines); the `voiceEntry`
plugin and its comment; the `/harness` proxy **if** the app no longer serves
`/voice` (option A); and, on the integration branch, the `__VOICE_BUILD_INFO__`
define.

**Workspace registration:** the root `workspaces` glob `packages/*` already
includes the new directory, so there is no root edit for the move itself. Two
optional root touches: `scripts.dev` uses `concurrently` for server+web — a
third lane for the voice server is what makes `npm run dev` serve the page; and
root `npm run typecheck --workspaces` picks the package up only if it declares
a `typecheck` script.

---

## 4. The risks, named

1. **CSS inheritance, and one live bug in it.** Split out the voice block and
   the page loses `body`'s font/colour/ground and the `button`/`input`
   inherit rules; carry them (§5). Worse, and not previously noticed: **the
   standalone page cannot go dark at all.** The dark tokens exist only under
   `:root[data-theme="dark"]`, and nothing on this page ever sets that
   attribute — `src/lib/theme.ts` (the resolver, a zustand module) is imported
   by React components, and the app's inline pre-paint script is in
   `packages/web/index.html`, which the voice page does not load. Measured
   just now in a real browser: with `prefers-color-scheme: dark` emulated and
   nothing set, `--ground` stays `#fbfbf9`; setting `data-theme="dark"` by hand
   flips it to `#0e0f12`. **The dark screenshots in this branch's evidence were
   only possible because the harness of the screenshot set the attribute by
   hand** — the page as served is light-only, and **the dark half of that
   visual review is therefore not evidence**: a pass on a rigged input proves
   nothing. This is a live bug, independent of the move, and it is **astra's to
   fix, not the extraction's** — coord routed it on 2026-09-13. The extraction
   only has to make sure the page it inherits sets its own theme (§5).
2. **Inter is not loaded by this page.** The only `@font-face` for it is
   inline in `packages/web/index.html:66–71` (serving `/fonts/inter-latin.woff2`
   from `packages/web/public/`). The voice page gets the *family name* from the
   app stylesheet's `body` rule and then whatever the system has; on a machine
   without Inter installed it renders the fallback stack. Decide once, in the
   package: copy the face and its `@font-face`, or state the system stack.
3. **Serve path and HMR.** `/harness` must exist on the serving origin (§2.4);
   the HMR websocket follows the server that serves the page; two dev servers
   with `--strictPort` is how a lane loses its port (it happened twice today:
   `:5199` was taken over mid-session by another worktree, and my own `:5198`
   server died and silently served nothing but cached pages).
4. **Build-info injection.** The define lives on the integration branch's
   config, not this one. The page reads it defensively (absent → "build tag not
   injected"), so nothing breaks if it is not carried — but the tag is then
   untrue for exactly the audience it exists for.
5. **Test traps.** `voicepage.test.ts:21`'s `process.cwd()` path (above); the
   jsdom directive; and the root `setupFiles`/`globalSetup` that a package-local
   config stops inheriting.
6. **The design-guard counters move — downward, so nothing reddens.** Verified
   against the guards themselves: the voice block has **zero literal** spacing,
   `border-radius` or `font-size` values (all `var()`), so `scale.test.ts`'
   counts are untouched; it declares no `:root` tokens, so `tokens.test.ts` is
   untouched; its classes are declared once, so `oneblock.test.ts` is untouched.
   The three ratchets that read files it leaves — `copied-rules` (≤59),
   `undocumented-exports` (≤331), `unused-exports` (≤39), all
   `toBeLessThanOrEqual` on counts from `scripts/measure.mjs`, which walks
   `packages/web/src/{components,pages,lib}` and `packages/web/src/styles.css` —
   can only **drop**. Landing the move without lowering the ceilings is safe
   and leaves the improvement unrecorded; the guards' own doc says the fix for
   that is to lower the number.
7. **Do not fold in the harness's page.** `packages/cli/src/voice-harness-page.ts`
   (on `feat/voice-harness-rc`) is the harness's own embedded page — a
   different artifact with a different owner. The extraction is the
   Vite-served page only.
8. **`lib/voice.ts` is the wire contract, and the harness owns the other end.**
   After the move it is the one place in the repo that must stay honest about
   `/state`, `/session/*`, `/log`, `/key`, `/audio`, and the setup/confirm
   contract frozen on bead `isocan-xsh.8`.

---

## 5. The thing being carried that should not be

The map's one real finding: **the page imports 6,876 lines of stylesheet to use
481 of them.** Everything else in the graph — two import-free modules and one
HTML entry — is already exactly what it looks like.

So the extraction should split `src/voice.css` out of `styles.css`, and it
should contain, in full:

  - the voice block (lines 6396–6876), unchanged;
  - the **13 colour tokens + `--radius`** the block references, with both theme
    values copied from the app's `:root` (copied deliberately, not imported:
    after this the page must be able to ship without the app);
  - the five base element rules it silently relies on — `body`'s margin, font,
    colour, ground; `button`'s `font: inherit; cursor: pointer`; `input`'s
    `font: inherit; color: var(--ink)`;
  - and **a theme resolver** so `data-theme` is set by the page rather than by
    a screenshot harness (astra fixes the live bug first — §4 risk 1; what this
    file must carry is the same small resolver, or the receipt of it).

What must *not* come along: the other ~6,400 lines (the app's components,
canvas chrome, front page), the `/api` proxy, the React plugin, the app's
tsconfig, and the root test setup. That is the whole point of standalone, and a
move that copies the coupling into a new folder would miss it.

---

## 6. The sequence, and what acceptance means

**Gated**: execution starts only when astra's cog/mobile work has landed **and**
an independent review confirms those files are quiet. Nothing here starts early
— moving files across a live edit is what produced tonight's duplicate symbols.

1. astra lands the cog/mobile work **and the dark-mode fix** — routed to astra
   on 2026-09-13; an independent review then confirms the files are quiet.
2. **The extraction, in one run**, as separate commits rather than one big one:
   files → package config (vite/tsconfig/vitest/package.json) → the CSS split →
   test path fixes → the serve path (option A, confirmed) → the `@font-face`
   decision.
3. **Acceptance, checked rather than asserted:**
   - `http://127.0.0.1:5199/voice` loads the page (`#hero` present; `/voice` on
     the app server still lands there);
   - a real session starts against the harness on 7654 and the state model
     reaches `listening`;
   - `npm test` and `npm run typecheck` green for **both** `@isocan/web` and
     `@isocan/voice-agent`;
   - the build-info tag tells the truth from the new home;
   - **the dark screenshots are re-shot from the real page with nothing set by
     hand** (coord, 2026-09-13): emulated `prefers-color-scheme: dark`, no
     `data-theme` written by the harness, and the page is dark because it *is*
     dark — the resolution of the evidence-integrity failure recorded in §4.
4. Then, and only then, delete what `packages/web` gave up, in the same run that
   proves nothing imports it.
