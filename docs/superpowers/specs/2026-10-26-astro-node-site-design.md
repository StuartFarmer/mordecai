# Astro node site and Markdown/MDX documentation

Approved direction: migrate the node site to Astro and replace mdBook with Markdown/MDX, retaining interactive accounts and demos.

## Approach

Use Astro static output, shared layout components, and the existing hash SPA/session for the node application. Author Manifesto and Design in Markdown. Render all existing documentation at its current /docs/*.html URLs, with a shared documentation layout, chapter navigation, headings, search, and previous/next links. MDX supports trusted repository components; demonstrate with live read-only node status in the Field Guide. Keep existing React demo bundles and the gateway API.

Alternatives considered: retain mdBook (user chose to replace it); migrate immediately to separate client-routed pages (unnecessary account/pending-transaction lifecycle risk). Starlight offers a ready-made docs UI but a minimal shared Astro layout better preserves the requested styling and existing URLs; use Pagefind for static full-text search.

## Constraints

Preserve content, old chapter URLs and explicit anchors, existing private-key backups, account grants/rate limits, all six demos, and browser-only signing. Documentation continues to open separately so it cannot discard an active account. No blockchain state changes or data resets. Preserve unrelated block-explorer work in the other checkout. All generated output remains ignored. Build/runtime stay in the existing Docker service; remove mdBook installation and update Node requirements for pinned Astro.

## Scope

New site source lives in packages/gateway/site; output in packages/gateway/public/site. Gateway serves generated site assets with traversal protection and normal 404s. Existing public CSS/images and React builds remain. Replace book.toml/SUMMARY.md with navigation data, convert mdBook-specific includes/anchors, and update build, CI, Docker, and author instructions.

## Validation

Full production build and existing tests; generated-page/link/anchor/search checks; gateway asset and traversal tests; browser account navigation with no session reset, legacy links, all demos, MDX status updates, docs search, and mobile layout. Public deployment is not part of this migration.
