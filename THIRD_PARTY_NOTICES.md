# Third-Party Notices

The HELIX SVG mark in `docs/assets/helix-mark.svg` is a separately licensed artwork reused from SuperHelix77/Helix-Harness's AGPL-3.0 studio subtree. Editable source and the full license are included; see `docs/ASSETS.md` and `LICENSES/Helix-Harness-Logo-AGPL-3.0.txt`. It is not relicensed under the engine's MIT license. The RTK executable is an optional user-installed dependency and is not bundled. The Claude-Mem integration is a read-only compatible database adapter, not a redistributed observer service.

The goal engine, evidence receipts, Tool Flow, process supervision, retention,
context aging and native operation bridge were adapted from codex-router.
The original MIT copyright notice is preserved in LICENSE. Imported source
hashes and the upstream base commit are in docs/upstream-provenance.json.
This is a curated working-tree extraction, not an assertion that the source
checkout or its unrelated changes have been audited for release.

React and React DOM are MIT licensed. Lucide icons use the ISC license.
IBM Plex Sans uses the SIL Open Font License 1.1. Electron is MIT licensed
and includes additional Chromium/Node notices in its distributed packages.
Vite, Playwright and electron-builder retain their respective upstream notices
in the locked dependency distribution. No fonts or artwork are fetched at run time.

Exact runtime notices, including IBM Plex Sans's full OFL text and Lucide's
additional icon attribution, are preserved in LICENSES. Regenerate them from
the locked installation with `node scripts/third-party-notices.mjs`; the
manifest binds each copied notice to a package version and SHA-256. Packaged
Electron also retains its distributed Chromium and third-party notices.
