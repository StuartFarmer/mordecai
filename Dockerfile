# syntax=docker/dockerfile:1
FROM rust:1.94.1-bookworm AS contracts
RUN rustup target add wasm32-unknown-unknown \
    && apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY compiler/ compiler/
COPY contracts/runtime-rs/ contracts/runtime-rs/
RUN mkdir -p /wasm && for name in hex hex_escrow frontier outpost goods_market chess_wager information_bounties; do \
      python3 compiler/mordecaic build "compiler/examples/$name.pysc" -o "/tmp/contracts/$name" --wasm \
      && cp "/tmp/contracts/$name/$name.wasm" /wasm/ || exit 1; \
    done

FROM node:22.23.4-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.34.4
WORKDIR /app
COPY . .
COPY --from=contracts /wasm/ contracts/dist/
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22.23.4-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libatomic1 tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/ /app/
ENV NODE_ENV=production PORT=8790 DEMO_DIR=/data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/head',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/node-demo.mjs"]
