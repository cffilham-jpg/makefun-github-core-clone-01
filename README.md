[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cffilham-jpg/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cffilham-jpg/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
https://make.fun/bounty/github-core-clone-01

# Memory Forge

A standalone GitHub-compatible forge written in TypeScript using only Node's standard library.
Repositories, git objects, branches, issues, labels, comments and pull requests share one in-memory store.
Contents writes create SHA-1 git trees and commits; squash merges check for conflicting file changes.

Run with Node 22.18 or newer; no installation is needed:

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:18081 MAKEFUN_SHOP_TOKEN=your-token node main.ts
```

The process binds an ephemeral port, registers it with the local trial coordinator, and exits when
that coordinator reports completion. `/healthz` is public; API requests require the configured bearer
token. Data lasts for the process lifetime. Dates derive from `MAKEFUN_TRIAL_NOW` and a monotonic
creation counter.

MIT licensed. Built for the [make.fun forge competition](https://make.fun/bounty/github-core-clone-01).

The forge serves REST v3 at `/api/v3`, a GraphQL v4 subset at `/api/graphql`, MCP JSON-RPC at `/mcp`,
and git smart HTTP at `/{owner}/{repo}.git`. Git upload-pack supports v2 and v0, shallow and incremental
fetches, HEAD symrefs and annotated tag peeling. Receive-pack accepts full objects and delta packs,
checks pack checksums, and applies fast-forward updates with per-ref status reports.

GraphQL supports repository and issue/pull reads, cursor connections, stable global node ids,
introspection probes, issue/comment/pull mutations and request batching. MCP offers repository,
issue and pull creation/read/merge tools over the same store, with discovery and legacy initialization.
The GraphQL implementation covers the competition's documents rather than GitHub's entire schema.

Local validation: all 120 kit conformance checks pass. Harness scripts, logs and exports are kept
outside this repository. No git binary, external service, model call, dependency or disk persistence
is used by the running forge.
