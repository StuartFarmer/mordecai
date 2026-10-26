# Authoring the node site

Astro builds the node website and documentation into static files served by the
existing gateway. Markdown is enough for ordinary prose. Use MDX when a chapter
needs an imported component, such as the live node example in the Field Guide.

## Local development

From the repository root, with Node 22.23.4 or newer and pnpm 10:

```sh
pnpm install
pnpm build
node scripts/node-demo.mjs
```

In another terminal:

```sh
pnpm dev:site
```

Open `http://localhost:4321`. If your node uses another port, run
`MORDECAI_DEV_NODE=http://127.0.0.1:8791 pnpm dev:site` instead. Astro reloads content and component edits. Its dev
server proxies the API, account/demo bundles, shared public assets and built search
index to the node on port 8790. The signing and registration requests stay on the
browser's origin. If the node is stopped, prose still renders but live examples
and account operations are unavailable. After changing account/demo JavaScript,
run `node scripts/build-node-web.mjs` and refresh the page. After adding chapters,
run `pnpm build:docs` to regenerate the search index.

## Files to edit

- `packages/gateway/site/`: Astro pages, layouts, components, and editorial content.
- `packages/gateway/public/mordecai.css`: shared visual styling.
- `docs/src/`: Markdown and MDX documentation chapters.
- `docs/navigation.json`: chapter titles, ordering, and URL slugs.
- `docs/threat-model.md`: canonical threat model, imported by the MDX chapter.

To add a chapter, create `docs/src/example.md` or `example.mdx`, start with one
H1 heading, and add `{ "title": "Example", "slug": "example" }` to the relevant
navigation group. Its published URL is `/docs/example.html`. Repository links
such as `[Example](example.md)` are rewritten to their HTML URLs during the build.
Keep explicit HTML anchor elements when preserving an older bookmark.

## Interactive MDX

The Field Guide imports the reusable Astro component like this:

```mdx
import LiveNode from '../../packages/gateway/site/components/LiveNode.astro';

# Field Guide

<LiveNode />
```

The component renders useful HTML and includes a small browser script that reads
`/api/head`, refreshes every second, and handles an offline node. Its **Refresh now**
button provides a manual update. Other guides can import the same component.
An Astro component's frontmatter runs during the build; its `<script>` runs in the
browser. Keep live node requests in the browser so the build needs no running node.

MDX is trusted repository code. Never compile public Microblog posts or bounty
responses as MDX. Components must not receive private keys in server props,
rendered HTML, or build output. The account and demos continue to share the
existing browser-only signing session; documentation opens in a separate tab.

## Build and verification

```sh
pnpm build:docs
pnpm check:site
```

The build renders every chapter, indexes full-text search with Pagefind, and checks
local links, assets, old Field Guide anchors, and the MDX example. Generated files
are ignored by Git. `pnpm build` also compiles packages and account/demo bundles.
The existing Render container serves everything from one origin without mdBook
or a second site server.

## Explorer and Apps

The shared navigation exposes `/#/explorer` and `/#/apps`. Both are rendered by
`packages/gateway/site/components/Explorer.astro`, with editable MDX introductions
in `site/content/explorer.mdx` and `site/content/apps.mdx`. The browser controller
in `packages/gateway/web/explorer.js` reads current blocks, receipts, registrations,
and app-chain data from the gateway. These views work without an account and keep
an active account in memory when navigating within the node page.

The [gateway guide](../apps/gateway.md) describes the explorer routes, pagination,
peer availability, and the distinction between live app heads and settlement anchors.
