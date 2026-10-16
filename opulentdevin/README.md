# OpulentDevin

Native GPUIX desktop application using Zuse's pinned headless backend. React renders GPUI primitives through the release NAPI module; there is no Electron application or embedded webview. This is an in-progress native port, not a declaration of complete Zuse parity.

## Run

Requires Bun 1.3.14 or newer, Node 24 (Zuse uses node:sqlite), Git, npm and a working native graphical session. Linux requires Wayland for the installed GPUIX 0.10.0 binary. X11-only sessions need a nested Weston compositor or a separately verified source-built native renderer. A headless init success is not a visible window.

```sh
cd opulentdevin
npm ci --workspaces=false
bun bootstrap-zuse.ts
bun install-native.ts /absolute/path/to/verified-native-delivery
bun run desktop
```

The bootstrap checks out Zuse revision `ff7b4db6b15c8445c323ad39278905e951ecf13b`, installs only server/client/SSH workspace dependencies and builds node-pty. It refuses to reset an existing checkout or use tracked local changes. Set `OPULENTDEVIN_ZUSE_DIR` to an existing matching checkout. The generated `zuse-runtime` link and dependencies are not committed.

`install-native.ts` verifies the reviewed manifest and every file hash, then installs the custom editor and window-close renderer outside npm under `.native-runtime/releases/<binary-sha256>`, retaining older releases. `main.tsx` activates it before dynamically importing GPUIX, so an npm reinstall cannot silently replace the tested native editor with the stock binary. The verified delivery is Linux x64; other platforms need a separately generated, tested build. The source patch and complete native runtime delivery accompany the review checkpoint.

`bun run build` emits the app bundle and a separate native bootstrap entry; `bun run start` runs `dist/native-entry.js`, which verifies and activates the pinned native runtime before importing the application bundle. `bun launch.ts --built` uses the same entry. `bun native-test.ts --built` exercises the packaged entry rather than the source entry. This is not a signed platform installer. Neither command publishes a release or deploys a service.

## Architecture and state

- `main.tsx` owns a loopback Node Zuse sidecar and the native window. `app.tsx` owns native navigation and environment selection.
- `backend.ts` uses Zuse's real Effect WebSocket protocol, version handshake and typed RPC group. SQLite, provider drivers, cloud authority, worktrees and permissions remain Zuse-owned.
- `connection.tsx` reuses Zuse's connection supervisor and timeline driver, including descriptor-pinned environment identity, cursor/generation fences, private atomic timeline cache and older-history paging. Local reconnect is bounded; remote selection is identity-verified and manually reconnected.
- `drafts.ts` stores rich unsent composer state per verified environment/workspace/session, with revision-bound acknowledgement clearing.
- `outbox.ts` atomically preserves exact send/create identities under private mode 0600. Unknown outcomes remain pending until explicit retry; successful RPC acknowledgement removes the pending payload. This file contains user-authored prompt text and is not an encrypted credential store.
- `transcript.tsx` renders all canonical message variants and live questions/permissions/plans. Interaction retries retain intent in process memory; restart durability for these interactions is still incomplete.
- `workbench.tsx`, `editor.tsx` and `terminal-grid.tsx` provide native files, editor, Git and parser-backed PTY surfaces. The terminal parser is headless xterm; no DOM renderer is used.
- `settings*.tsx` preserves typed provider/model, cloud and SSH workflows. Remote changes require explicit controls; no automatic cloud provisioning occurs on startup.
- `browser.tsx` paints fresh browser image frames into native GPUI images. Set `OPULENTDEVIN_BROWSER_CDP` to an explicitly authorised loopback CDP endpoint and press Connect. It creates an isolated context and never imports an existing tab/profile/cookies. It does not launch or download a browser. Bounded silent recording uses installed ffmpeg; overlays are rasterised into native frames with sharp. Remote forwarding, credential injection, downloads, drag and IME composition remain unsupported.

The GPUIX native input extension renders editable syntax in the existing input TextRuns, emits real UTF-16 caret/selection revisions and accepts revision-fenced selection requests. It preserves native IME and undo ownership; it does not introduce a browser editor or claim full LSP/multi-cursor functionality.

State defaults to `$XDG_DATA_HOME/opulentdevin` or `~/.local/share/opulentdevin`; override with `OPULENTDEVIN_DATA_DIR`. Zuse also has its own configuration-directory policy; changing the data directory alone does not necessarily isolate every provider setting. Tests use controlled temporary state and do not invoke paid inference.

## Design provenance

The archive repository was cloned at `415a10b178f180da5da3d45dfe5a58f8ceeb84d6`. All 141 ZIPs were classified and 73 Devin-relevant bundles were safely extracted and hashed. `theme.ts` translates measured neutral surface colours, typography and dimensions. Icons are original geometric SVGs. Captured private conversations, account information, screenshots, embedded HTML payloads and canned replies are not app fixtures or runtime data.

The detailed provenance and evolving parity matrix are delivered separately as review evidence. Exact pixel fidelity across every archived state is not yet verified.

## Checks

```sh
bun run typecheck
bun run test
bun run build
bun native-test.ts
```

The last command requires Linux Weston and drives an actual GPUI window, not a headless React tree. Browser protocol/native-image tests are opt-in through `OPULENTDEVIN_BROWSER_CDP` and `OPULENTDEVIN_BROWSER_NATIVE_BUN`. Skipped offscreen tests do not prove rendering. Keep live UI failures visible.

## Licence

This application boundary is AGPL-3.0-only because it reuses Zuse source. See LICENSE and THIRD_PARTY_NOTICES.md. The surrounding GPUIX framework remains Apache-2.0; this application does not relicense it. Preserve the pinned Zuse source and its notices when distributing corresponding app source.
