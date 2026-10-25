# Simple node homepage and bundled documentation

Status: approved by the user.

## Intent

Give each node a small, readable homepage and put instructional content in the
existing mdBook. The user selected a separate landing page with bundled
documentation rather than using a book chapter as the homepage.

## Homepage

- Title: Mordecai.
- Tagline: P2P toolkit for a distributed world.
- Live details: node reachability, network ID, block height, and latest block hash.
- Links: Read the documentation and View chain API.
- A compact single-column layout with ordinary typography and minimal decoration.
  Remove the large guardian artwork, promotional sections, and animations.
- Keep keyboard access, mobile readability, loading and error states, and the
  existing periodic refresh of live data.

Proposed styling choice: retain a restrained dark background consistent with the
book's existing Ayu theme. This is an implementation recommendation, not an
additional user preference.

## Documentation

- Move the complete six-part field guide into a Markdown chapter near the front
  of the existing book, preserving commands, explanations, and the app starter.
- Use mdBook's navigation and code-block tools instead of maintaining a separate
  HTML guide, stylesheet, and copy-button script.
- Keep existing reference chapters and link to them where useful.
- Redirect old guide URLs to the new chapter so existing links keep working.

## Serving and building

- `/` serves the compact homepage.
- `/docs/` serves the generated mdBook and its assets through the existing node
  gateway. Running a node does not require a separate `mdbook serve` process.
- `/api/` retains its existing behavior and supplies the live homepage data.
- Include a documented build step that produces the bundled book before
  packaging or deploying a node. Ship generated documentation with the gateway;
  node operators do not need mdBook installed at runtime.
- Preserve the existing custom frontend override using `--static`.

## Approaches considered

1. Small homepage plus mdBook: selected by the user. Keeps node information
   immediately visible while using the existing book for all instructions.
2. All content inside mdBook: fewer separate page styles, but the node homepage
   becomes a documentation chapter with the book's navigation.

## Scope and verification

Change the landing assets, move the guide into the book, add documentation
serving/build integration, and update affected tests and instructions. No new
node statistics, application features, or frontend framework.

Verify homepage/API behavior, documentation and asset routes, old-guide
redirects, and custom frontend precedence. Build the book and TypeScript,
run lint and affected tests, and inspect the rendered homepage at desktop
and mobile sizes.
