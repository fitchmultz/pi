# Upstream integration: 2026-11-18

The fork merges upstream `942842439e1f1d65f68a61857ddb7590b80c5a92`, 323 commits after the latest official release, v1.5.2. The previous upstream baseline was `147dc531381960e2dd5e69fd05b92bd056b678ea`.

## What comes from upstream

- Fullscreen scrolling uses upstream's cached, read-only render output and viewport drawing ([#11968](https://github.com/earendil-works/pi/pull/11968)). Extensions can read a component's lines directly. To modify them, make a copy first. The fork keeps its terminal text selection, source links, compact cards, and restart behavior.
- GPT-6.2 Astra and Sol use upstream's OpenAI, Azure, and Codex model definitions and default selection. The fork keeps its Cloudflare AI Gateway entries and pricing rules. Upstream also reconnects when the Codex WebSocket expires ([#12229](https://github.com/earendil-works/pi/pull/12229)).
- Session replacement reports new diagnostics once in every mode. RPC and JSON clients receive entries appended by `session_start` handlers. Successful managed restarts still suppress the resume command, and other exits print it on its own line.
- Chord closes a worker's link and waits for its queued store commits before publishing its exit. The fork still keeps a worker in `stopping` if its `ready` arrives late. p2 uses upstream's composer and image fitting before messages are written to the transcript. The fork keeps its offline outbox behavior.
- Upstream bumps Undici to 8.12.4. Both npm lockfiles are regenerated from the merged manifests. The source for upstream's p2 Mac packaging and p3 development is included. The p2 Mac signing and release job runs only in the upstream repository.

## Verification boundaries

GitHub Actions runs CI, Environments, and Nix checks on pull requests whose base is another stack branch as well as on pull requests to `main`. Environments and Nix keep their existing path filters. Each public extension is still expected to work with the latest official release and the maintained fork.
