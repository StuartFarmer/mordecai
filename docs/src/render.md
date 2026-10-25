# Host the demo on Render

The root `render.yaml` Blueprint runs the node website, wallet, faucet, book and
all six demos in one Docker web service. It includes a persistent disk at `/data`,
port `10000`, and the `/api/head` readiness check.

## Deploy

1. Open [Deploy to Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FStuartFarmer%2Fmordecai%2Ftree%2Fmain).
   Alternatively, select **New → Blueprint**, connect `StuartFarmer/mordecai`,
   select branch **`main`**, and use `render.yaml`.
2. Review the proposed resources and current cost. The Blueprint selects the
   **paid `0.5c-512mb` plan** (formerly Starter), a **1 GB disk**, and Frankfurt.
   Render's free web services cannot attach persistent disks and are unsuitable
   for keeping this demo's balances and worlds. No separate database is needed.
3. Deploy the Blueprint. Leave the Docker start command unchanged. The first
   start creates the network and deploys its contracts before the health check
   passes. The launcher refuses to run on Render without a disk mounted at `/data`.
4. Open the service's HTTPS `onrender.com` URL. Create a demo wallet, download its
   backup, claim test CAI, and choose a demo. Verify all endpoints with:

   ```sh
   node scripts/check-node-demo.mjs https://YOUR-SERVICE.onrender.com
   ```

The smallest paid instance is a starting point for a small demo, not a measured
concurrent-player capacity. Watch memory, CPU and disk usage; increase the plan
or disk size as needed. Review the actual charge shown by Render before deploying.

## Data and updates

Keep one instance and its disk. `/data` stores node identities, chain history,
contract deployment receipts, Chess rooms and Microblog posts. The first deploy
creates a new network; local wallets and balances are not migrated.

Code auto-deploys are disabled. To update, use **Manual Deploy → Deploy latest
commit** after reviewing changes. Blueprint configuration changes can still
auto-sync; set **Auto Sync → No** on the Blueprint if you want manual approval
for those too. Deployments with a disk have a brief outage.

Never delete `/data` to resolve a deployment error. Back up the disk, keep the
same contract compiler and `HEX_TIMEOUT_MS`, and plan migrations for changes to
contract deployment bytes. A bootstrap payload mismatch should be investigated
or rolled back rather than resetting the network.

## Proxy and local verification

Render routes public requests through Cloudflare. The launcher enables
`MORDECAI_TRUST_RENDER_PROXY=1` and uses `CF-Connecting-IP` for visitor limits.
It does not trust arbitrary entries in `X-Forwarded-For`. Same-origin writes use
the request's `Host`; Railway's forwarded-host handling remains disabled.
Keep the gateway behind Render's public HTTP edge and do not proxy untrusted
private-network requests directly to it with these headers.

To exercise Render startup locally, use a separate test volume:

```sh
docker build --platform linux/amd64 -t mordecai-demo .
docker run -d --name mordecai-render -p 127.0.0.1:8791:10000 \
  -e RENDER=true -e PORT=10000 \
  --mount source=mordecai-render-data,target=/data mordecai-demo
node scripts/check-node-demo.mjs http://127.0.0.1:8791
```

Wait for the gateway to become ready before running the check. Restarting the
container retains the same network on the volume. All validators run on one host;
this is a test-CAI demo, not a production settlement network. Public posts need
operator moderation and bounty submissions are public and permanent.

References: [Blueprint fields](https://render.com/docs/blueprint-spec),
[persistent disks](https://render.com/docs/disks),
[compute plans](https://render.com/docs/compute-plans),
[pricing](https://render.com/pricing),
[Render's edge](https://render.com/articles/how-render-handles-ddos-attacks), and
[Cloudflare visitor headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/).
