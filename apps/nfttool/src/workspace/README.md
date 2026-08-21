# 611nft Workspace Source

This directory is the canonical frontend source for the local 611nft business workspace.

It owns wallet management, wallet groups, balance queries, distribution, token collection,
approval, contract calls, follow mint, advanced mint, transaction history, and the local
Live Mint implementation. The NFT TOOL Umi shell embeds the Vite-built workspace at
`/opensea/`; it does not load a remote NFT TOOL runtime.

The product name and image assets remain 611nft-owned. Compatibility paths under the
repository-level `src/` point back to this directory so existing tests and tooling keep
their stable imports.
