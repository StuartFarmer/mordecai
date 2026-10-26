# Astro Node Site Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved migration in the isolated worktree.

**Goal:** Replace handwritten site templates and mdBook with Astro and Markdown/MDX while preserving account and demo behavior.

**Architecture:** Static Astro output served by the existing gateway. Shared Astro layouts and editorial content; existing hash SPA and signing session remain. Documentation uses Markdown/MDX and a static search index.

**Tech Stack:** Astro, @astrojs/mdx, Pagefind, existing browser JavaScript/React, TypeScript gateway.

**Spec:** ../specs/2026-10-26-astro-node-site-design.md

## Global Constraints

Preserve current style, documentation URLs/anchors, all content, browser-only keys and one-million-CAI registration. Keep original demo data. Do not modify the other checkout's explorer work.

## Review Focus

- Navigation and documentation links must not discard an active account or duplicate polling.
- Generated paths must not expose source/private files or turn missing assets into successful HTML.
- Existing documentation links, explicit anchors, and included threat model must render.
- MDX widgets handle unavailable nodes safely and never receive signing keys.
- Clean Docker/CI builds must work without mdBook and serve generated/search assets.

### Task 1: Static site and documentation

- [x] Add generated-site self-check for all chapters, links/anchors, MDX widget and search outputs; observe missing-build failure.
- [x] Pin Astro/MDX/Pagefind; create shared layout, header/footer/account components and index/account pages.
- [x] Extract Manifesto/Design Markdown; render chapters using navigation data and preserve URLs/anchors/includes.
- [x] Add live node MDX component and documentation full-text search.
- [x] Build and run self-check.

### Task 2: Gateway and build integration

- [x] Extend gateway tests for generated homepage/account/docs/assets and traversal/404 handling.
- [x] Serve generated site, preserving custom demo sites and legacy URLs.
- [x] Replace mdBook build/CI/Docker setup; add dev command with same-origin API proxy and author guide.
- [x] Build, lint, and run the complete suite; commit implementation.

### Task 3: Browser verification and delivery

- [x] Use isolated preview to verify account creation/load/navigation, all demos, MDX updates, search, legacy URLs and mobile layout.
- [x] Have a fresh reviewer assess the final diff; address material findings with tests.
- [x] Commit verification notes and push migration branch; preserve the active explorer checkout.

## Verification ledger

- Static build: all 37 chapters, old anchors, MDX widget, search index, links/assets pass `node scripts/check-site.mjs`.
- Gateway routing tests: new page/search test failed before routing integration, then passed.
- Review: fresh reviewer found rooted SPA links reset sessions on `/index.html` and standalone account URLs. Added four regression cases, observed failures, fixed contextual navigation, then verified in the browser.
- Full suite: 383/383 passing with `--maxWorkers=1`. One parallel run had transient HTTP protocol failures on local test sockets; isolated gateway suite and sequential full suite passed without backend changes.
- Browser: 1,000,000 CAI registration, load/close, session through About and six demos, legacy entrypoints, MDX auto/manual refresh and offline recovery, documentation search and mobile overflow checks passed.
- Dev server: port 4321 serves all routes and proxies the isolated node/API/account/search on port 8791; live MDX works.
- Ruling: retain hash SPA and separate documentation tabs — avoids changing signing/transaction lifetimes; normal document reload still clears keys as before.
- Ruling: use a shared minimal docs layout with Pagefind rather than Starlight — preserves existing visual styling and URLs, with a small custom navigation layout to maintain.
- Existing ignored WASM artifacts were copied into the isolated checkout for tests; Docker compiles its own demo artifacts. No chain data or operator keys copied into Git.

- Docker: linux/amd64 image built with Node 22.23.4 and no mdBook installation. Temporary container passed all six demo/API checks plus MDX/search assets and traversal rejection; container removed after verification.
- Delivery: implementation commit `84d6ef7` pushed to `feat/astro-node-site`. Development preview on localhost:4321 uses the isolated node on 8791; existing node data and explorer checkout are untouched. No main merge or Render deployment performed.
