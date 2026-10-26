Start with one question: who needs to agree?

## Data between peers

Holepunch connects peers over encrypted connections. Hypercore feeds provide signed, append-only histories that interested peers can replicate. Conversations, documents, and application content can be shared without asking the whole network to agree on every update.

## Agreement within an app

When participants need a shared order of events, an application can run its own chain. Its validators execute the same rules and agree on the result. Games and shared worlds can use this layer for state that matters to their participants.

## A common settlement layer

The settlement chain handles CAI payments, ownership, escrow, and contracts. App chains can submit results signed by their registered validator quorum to settle an agreement. Payments stay on the settlement chain; the result is trusted to that app's quorum.

## One identity across applications

An Ed25519 account gives a person a signing identity they can use across apps. The SDK connects that identity to payments, contracts, and peer-to-peer data. Contracts run as deterministic WebAssembly, with Rust and a Python-like contract language available to developers.

## This website is a gateway

The browser signs with your account and talks to this node over HTTP. The hosted demo runs its validators together on one host and uses test CAI. It lets you explore the toolkit; independent peers and validators are part of running a distributed network.

Read more in the [architecture guide](/docs/architecture/overview.html) and [app-chain design](/docs/architecture/app-chains.html).
