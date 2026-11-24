# pi-live-delivery

![Live Delivery workbench](assets/banner.png)

Live delivery as a pi package: versioned directory snapshots, a rolling milestone
plan, explicit preview entries, and a loopback workbench — for pi, without any
Codex host machinery.

- **Install** (local): `pi install ./pi-live-delivery` — or `pi -e <extension.ts>`
  for a single invocation.
- **Status**: complete scaffold — vendored engine, jiti loading, in-process
  workbench lifecycle, all four tools, feedback injection + keep-working
  continuation, and the `go` skill are wired and smoke-tested end-to-end
  (ld_begin → ld_publish ×2 → ld_status → wrap-up) in a scratch workspace.
  Project-local install verified as well as the skill discovery from the package.
- **Structure**: `extensions/` (the pi adapter — workbench lifecycle, tool
  registration, feedback injection), `resources/live-delivery/` (vendored engine
  sources, verbatim, one-way copy of the upstream `live-delivery/` tree).
  Do **not** edit the vendored files in place — re-sync from upstream and
  re-test. No esbuild bundle step: pi's jiti loads the TypeScript sources
  directly (verified against pi 1.6.0).

## Publish (to the Pi package gallery)

Publishing is an npm release. The gallery auto-discovers npm packages with the
`pi-package` keyword (already present in `keywords`) — no gallery submission
form is needed. Steps:

1. **Repo**: `git init` is done and everything is staged. Commit + push need
   your git identity (`git config --global user.name "<name>"` / `user.email`)
   and GitHub auth (`gh auth login`), then:

   `gh repo create <owner>/pi-live-delivery --public --source=. --push`

2. **npm**: `npm adduser` or `npm login` (or a publish token), then fill in the
   `"repository"` field of `package.json` with the repo URL, and:

   `npm publish`

   A scoped name like `@your-scope/pi-live-delivery` is also fine — unscoped
   `pi-live-delivery` is currently available (verified against the registry).

3. Optional gallery polish: `pi.image` / `pi.video` under `pi` in
   `package.json` add gallery previews. The value must be an absolute URL —
   the gallery fetches the image from that URL (precedent: pi-fabric's
   `https://raw.githubusercontent.com/.../media/banner.svg`); it is not read
   from the npm tarball. `assets/banner.png` is already in the repo and in the
   tarball; once the repo is pushed, add to `package.json`:

   "pi": { ..., "image": "https://raw.githubusercontent.com/<owner>/pi-live-delivery/main/assets/banner.png" }

   then republish so the metadata propagates.

After publish, pi installs it with: `pi install npm:<name>`

## Install & maintenance

`pi install ./pi-live-delivery` (or `pi install git:<your-repo>` after publishing).
Re-install after upgrading; project-local installs need project trust
(`pi install -l`, trust with `-a`). Dependencies come from `dependencies`
(`zod`); host-provided pi packages are peer deps — `npm install --legacy-peer-deps`
locally (never bundle `typebox` or `@earendil-works/pi-coding-agent`).
The vendored engine tree is a one-way copy of the upstream `live-delivery/`
sources — re-sync from upstream, re-test, never hand-edit vendored files.

## Decisions (locked, 2026-11-24)

1. **Package root = repo root.** Pi treats a git package's root as the package.
   The pi package ships as its own companion repo (the Codex/Qwen Code plugin
   stays untouched).
2. **No MCP server.** pi's in-process extension API (`pi.registerTool`)
   replaces the MCP server and the stdin/stdout hook pipeline.
3. **Schemas: accurate hand-written typebox schemas** for `ld_begin` /
   `ld_publish` / `ld_status` / `ld_done`. `callTool`'s zod parse stays the
   authoritative gate; the typebox schema is the model's contract.
4. **Browser auto-open**: keep `auto` + the engine's `shouldOpenBrowser`
   (desktop only; never SSH/CI).
5. **Changelog**: skip — the first install records the version without a
   changelog entry. Add `CHANGELOG.md` alongside the 1.0.0.
6. **Session resume**: the session key is `pi:<pi-session-id>`; resumed sessions
   keep the same key, so tasks, feedback and published versions survive resume
   (they are stored in the workspace's `.live-delivery/` state).
7. **Workbench**: in-process HTTP server in `session_start`, shut down in
   `session_shutdown`; loopback-only binding; ephemeral port per session
   (avoids fixed-port conflicts and stale URLs across restarts).

## Troubleshooting

The extension reports workbench start failures with a `Live Delivery` notification
("workbench failed to start"). The workbench page serves an empty shell when no
task exists — that is expected until the first `ld_begin`.
