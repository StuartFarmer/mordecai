# Host the demo on Railway

The root `Dockerfile` builds and serves the website, documentation, wallet,
faucet and all six demos in one service. It compiles all seven required demo
contracts with Rust 1.94.1 and builds the book with mdBook 0.5.2. Only the HTTP
gateway is public; the demo validators communicate inside the container.

## Create the service

1. Push the branch containing the Dockerfile to GitHub. In Railway, create a
   project and connect that repository and branch. Keep the root directory at
   the repository root. Railway detects the Dockerfile automatically.
2. Attach a **persistent volume** to this service at **`/data`** before deploying.
   The launcher refuses to start on Railway without a volume. Image builds do
   not create the live network or its keys.
3. Use these settings:

   | Setting             | Value                                                      |
   | ------------------- | ---------------------------------------------------------- |
   | Build               | Dockerfile at repository root                              |
   | Start command       | Leave empty; the image starts `node scripts/node-demo.mjs` |
   | Volume mount        | `/data`                                                    |
   | `DEMO_DIR`          | `/data` (already the image default)                        |
   | `PORT`              | `8790`, or Railway's supplied port                         |
   | Healthcheck path    | `/api/head`                                                |
   | Healthcheck timeout | 300 seconds                                                |
   | Restart policy      | Always                                                     |
   | Replicas            | 1                                                          |
   | Serverless / sleep  | Disabled                                                   |

4. Deploy, then select **Networking → Generate Domain**. Match its target port to
   `PORT`. Railway provides HTTPS; a custom domain is optional. The first start
   creates the test network and deploys contracts before the gateway becomes ready.
5. Open the generated URL. Create a **new demo wallet**, download its backup,
   claim test CAI, and choose a demo. Check the deployment with:

   ```sh
   node scripts/check-node-demo.mjs https://YOUR-SERVICE.up.railway.app
   ```

This command reads public endpoints; it does not create accounts or spend tokens.
No wallet secrets, faucet keys, or local chain data are copied into the image.
The first deployment generates its own identities on the volume. Local wallets,
balances and worlds are not migrated automatically.

Railway's older `railway.json`/`railway.toml` format is deprecated for new services.
This setup uses Docker autodetection and service settings, without adding a
deployment SDK to the application.

## Persistence and updates

`/data` holds node identities, chain history, the deployment journal, Chess rooms,
Microblog posts and tip associations. Bounties and game state are in the chains.
Keep this volume attached across deployments and enable volume backups. Stop the
service before making a manual filesystem copy so it is consistent.

Use a single service and volume. Expect a brief interruption when redeploying.
Never clear `/data` merely to fix a failed deployment: that would create a
different network and lose the existing demo state. If logs report a bootstrap
payload mismatch after changing a contract, roll back the image and prepare a
versioned contract migration.

The image builds contracts with a pinned Rust version. Changing that compiler or
contract source can change deployment bytes, so treat those changes as network
upgrades. Keep the same `HEX_TIMEOUT_MS` for an existing volume.

## Railway proxy handling

On Railway the launcher enables `MORDECAI_TRUST_RAILWAY_PROXY=1`. The gateway uses
Railway's `X-Real-IP` for per-visitor faucet/feed limits, and `X-Forwarded-Host` for
same-origin checks on Chess and Microblog writes. API responses are not cached.
Outside Railway, forwarded headers are ignored unless explicitly enabled.

Expose this service through Railway's HTTP/HTTPS edge only. Do not add a public
TCP proxy or an alternative direct route to its gateway port while proxy trust
is enabled. Review forwarded headers before adding another CDN in front.

## Test locally with Docker

```sh
docker build --platform linux/amd64 -t mordecai-demo .
docker volume create mordecai-demo-data
docker run -d --name mordecai-demo -p 127.0.0.1:8791:8790 \
  --mount source=mordecai-demo-data,target=/data mordecai-demo
docker logs -f mordecai-demo
```

Once the gateway is ready, open <http://127.0.0.1:8791> or run the check command
against that URL. `docker restart mordecai-demo` reuses the same data. The image
forwards termination signals to the launcher for orderly shutdown.

This is a public **test-CAI demo**, with all validators on one host. Faucet limits
reset on restart, public posts require operator moderation, and the data store is
intended for a small demo. Bounty submissions are public and permanent. A public
demo does not make this a production or independently operated settlement network.

References: [Docker deployment](https://docs.railway.com/builds/dockerfiles),
[volumes](https://docs.railway.com/volumes),
[network headers](https://docs.railway.com/networking/public-networking/specs-and-limits),
[healthchecks](https://docs.railway.com/deployments/healthchecks), and
[current configuration options](https://docs.railway.com/infrastructure-as-code).
