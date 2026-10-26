# Astro block explorer integration

User request: merge the approved Astro site into main as the deployment source,
then convert the completed block-explorer branch to Astro and Markdown/MDX.

## Scope and decisions

- Astro main `f1e5bb7` was pushed before integrating explorer `aa4f8c9`.
- Preserve explorer chain/RPC/gateway behavior, validation and browser controller.
- Move Explorer and Apps sections into `site/components/Explorer.astro`, render
  their introductory content from MDX, and add contextual shared-header links.
- Keep hash navigation to preserve in-memory accounts and pending transactions.
- Combine documentation and explorer styles; delete the obsolete handwritten
  homepage rather than serving two templates.
- Run the landing integration test against generated Astro output.
- Keep the existing Render service, main branch, disk and manual deployment policy.

## Verification

- Generated-page regression failed before porting the explorer, then passed.
- Full build and site check pass: 37 documentation chapters, anchors, MDX, search,
  local links and assets.
- Full test suite: 510 tests in 69 files pass with `--maxWorkers=1`.
- Lint and repository formatting checks pass.
- Fresh independent review found no material integration issues.
- Chrome checks on both the built gateway and Astro dev server pass: settlement
  blocks and decoded receipts; registered apps, details and live app heads;
  app-chain blocks; mobile width; account preservation; documentation navigation.
- Restarted Astro after merging to clear cached documentation modules; the updated
  preview remains at http://localhost:4321 with the isolated node on port 8791.
- Isolated node restart preserved existing data; all six demo endpoint checks pass.
- linux/amd64 Docker build passes with Node 22.23.4 and the frozen lockfile.
- The built container passes all six demo health checks and explorer checks for
  Astro mounts, settlement blocks, registrations and live app-chain reads.

Render auto-deploy is disabled. This session has no Render connector or deployment
credentials, so publishing main does not claim to update the live Render service.
Use Manual Deploy → Deploy latest commit for the existing service.
