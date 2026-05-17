# Cass rebuild runbook (gog-enabled)

Operational notes for the GCE-hosted Cass openclaw gateway, post the `cass-gog-install` change.

## Architecture

- **VM:** `openclaw-gateway` in GCP project `nathanwjclark`, zone `us-east1-b`. SSH via IAP tunnel only.
- **Source on VM:** `/opt/openclaw/` (owned by `ubuntu`). Has the fork `nathanwjclark/openclaw.git` as a remote.
- **Image:** `openclaw-extrapolation:dev` built locally from fork `main`. Old image preserved as `openclaw-extrapolation:dev-globalowner`, `:dev-gog`, etc. for rollback.
- **Container:** `openclaw-gateway`. Hardened: `--cap-drop NET_ADMIN,NET_RAW`, `--security-opt no-new-privileges`, `--memory 2g`, `--pids-limit 512`.
- **Port:** `127.0.0.1:18789` → container `18789`.

## Bind mounts

| Host                                                     | Container                   | Purpose                                                                                                     |
| -------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/home/nathanwjclark_gmail_com/.openclaw`                | `/home/node/.openclaw`      | openclaw state (config, sessions, DBs, plugins)                                                             |
| `/home/nathanwjclark_gmail_com/.openclaw/.config/gogcli` | `/home/node/.config/gogcli` | gog OAuth keyring (nested inside the parent mount; works because Docker resolves nested binds individually) |

Both should be owned `ubuntu:ubuntu`. UID 1000 inside the container (`node`) matches `ubuntu` on the host.

## Required env

| Var                      | Source                                                | Notes                                                                                                         |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | snapshot from previous container via `docker inspect` | only in container env, not on disk                                                                            |
| `OPENCLAW_GATEWAY_TOKEN` | same                                                  | rotate via `openssl rand -hex 24` + edit `openclaw.json` + recreate                                           |
| `BRAVE_API_KEY`          | same                                                  | for browser search                                                                                            |
| `GOG_KEYRING_BACKEND`    | hardcoded `file`                                      | required for headless keyring                                                                                 |
| `GOG_KEYRING_PASSWORD`   | secret store                                          | must match the password used when the keyring was created on the Mac; if rotated, keyring must be regenerated |
| `GOG_ACCOUNT`            | hardcoded `cassandra@animaresearch.ai`                | default account for `gog` invocations                                                                         |

## Rebuild openclaw image (fork-main update)

```bash
# On VM (SSH user has docker access; /opt/openclaw is ubuntu-owned)
sudo -u ubuntu git -C /opt/openclaw fetch nathanwjclark main
sudo -u ubuntu git -C /opt/openclaw checkout nathanwjclark/main
cd /opt/openclaw && docker build -t openclaw-extrapolation:dev . 2>&1 | tail -10
docker run --rm --entrypoint /usr/local/bin/gog openclaw-extrapolation:dev --version  # smoke

# Snapshot env, stop+rename, restart with same flags (see "Restart container" below)
```

If disk fills mid-build (>92% used), prune build cache first: `docker builder prune -af`.

## Upgrade gog version

1. Edit `Dockerfile`'s `ARG GOGCLI_IMAGE=` line: bump tag, refresh digest via `docker buildx imagetools inspect ghcr.io/openclaw/gogcli:<tag>` and copy the `Docker-Content-Digest` (registry API also works: `curl -sI -H "Authorization: Bearer $(curl -s 'https://ghcr.io/token?service=ghcr.io&scope=repository:openclaw/gogcli:pull' | jq -r .token)" -H 'Accept: application/vnd.oci.image.index.v1+json' https://ghcr.io/v2/openclaw/gogcli/manifests/<tag>`).
2. PR to fork `main`, merge, rebuild via the steps above.
3. No re-auth needed — OAuth tokens are in the keyring and gog reads them the same way across versions.

## Restart container (the canonical run command)

```bash
# Capture current env so we don't lose ANTHROPIC_API_KEY / OPENCLAW_GATEWAY_TOKEN
ENV_RAW=$(docker inspect openclaw-gateway --format '{{range .Config.Env}}{{println .}}{{end}}')
ANTHROPIC_KV=$(echo "$ENV_RAW" | grep '^ANTHROPIC_API_KEY=')
GATEWAY_KV=$(echo "$ENV_RAW" | grep '^OPENCLAW_GATEWAY_TOKEN=')
BRAVE_KV=$(echo "$ENV_RAW" | grep '^BRAVE_API_KEY=')

docker stop openclaw-gateway
docker rename openclaw-gateway openclaw-gateway-pre-<reason>

docker run -d \
  --name openclaw-gateway \
  --restart unless-stopped \
  --cap-drop NET_ADMIN --cap-drop NET_RAW \
  --security-opt no-new-privileges:true \
  --memory 2g --pids-limit 512 \
  -p 127.0.0.1:18789:18789 \
  -v /home/nathanwjclark_gmail_com/.openclaw:/home/node/.openclaw \
  -v /home/nathanwjclark_gmail_com/.openclaw/.config/gogcli:/home/node/.config/gogcli \
  -e "$ANTHROPIC_KV" -e "$GATEWAY_KV" -e "$BRAVE_KV" \
  -e GOG_KEYRING_BACKEND=file \
  -e GOG_KEYRING_PASSWORD='<from-secret-store>' \
  -e GOG_ACCOUNT=cassandra@animaresearch.ai \
  openclaw-extrapolation:dev
```

Verify: `curl -sf http://127.0.0.1:18789/healthz` → `{"ok":true,"status":"live"}`; `docker exec openclaw-gateway /usr/local/bin/gog auth list` shows cassandra.

## Re-auth flow (corrupted keyring, expired refresh, new account, password rotation)

Done on the Mac, never on the VM (VM is headless; OAuth needs a browser).

1. **OAuth client:** lives in GCP project `autoco-app` (numeric `936292291216`). If invalidated, recreate at https://console.cloud.google.com/apis/credentials?project=autoco-app → OAuth client ID → Desktop app → download client_secret JSON.

2. **Local dance** (Mac, with cassandra@animaresearch.ai as the OAuth consenter — use incognito or sign out of personal account first):

   ```bash
   export GOG_KEYRING_BACKEND=file
   export GOG_KEYRING_PASSWORD='<the-same-password-the-container-runs-with>'
   export XDG_CONFIG_HOME=/tmp/cass-gog-config  # isolates from any personal gog
   mkdir -p "$XDG_CONFIG_HOME"

   gog auth credentials /path/to/client_secret_*.json
   gog auth add cassandra@animaresearch.ai --services gmail,calendar,drive,contacts,docs,sheets
   gog auth list  # sanity
   ```

   If the wrong Google account is picked in the browser, gog refuses to store tokens — just retry after switching accounts.

3. **Ship keyring to VM:**

   ```bash
   cd /tmp/cass-gog-config && tar czf /tmp/cass-gogcli.tgz gogcli/
   gcloud compute scp /tmp/cass-gogcli.tgz openclaw-gateway:/tmp/cass-gogcli.tgz \
     --tunnel-through-iap --project=nathanwjclark --zone=us-east1-b
   ```

   On VM:

   ```bash
   sudo tar -xzf /tmp/cass-gogcli.tgz -C /home/nathanwjclark_gmail_com/.openclaw/.config/ --overwrite
   sudo chown -R ubuntu:ubuntu /home/nathanwjclark_gmail_com/.openclaw/.config/gogcli
   rm /tmp/cass-gogcli.tgz
   ```

4. **Delete the OAuth client_secret JSON from your Mac** once `gog auth add` succeeds — the secret is now inside the keyring; the standalone file is just a leak waiting to happen.

5. **Revoke any wrong-account grant** at https://myaccount.google.com/permissions if you accidentally consented as the wrong user (gog refuses the tokens locally but Google still records the grant on the user's account).

### Password rotation

The keyring is encrypted with `GOG_KEYRING_PASSWORD`. To rotate, you have to regenerate the keyring (no in-place re-encryption command in gog as of v0.17). Steps:

1. Choose new password, store it.
2. Run the full local dance (above) with the new password.
3. scp the new keyring to the VM.
4. Restart container with the new `GOG_KEYRING_PASSWORD` env value.

## Rollback

To revert to pre-gog state (e.g., gog broke something):

```bash
docker stop openclaw-gateway
docker rename openclaw-gateway openclaw-gateway-broken
docker rename openclaw-gateway-pre-gog openclaw-gateway
docker start openclaw-gateway
curl -sf http://127.0.0.1:18789/healthz
```

The pre-gog container still has its original env and binds. To revert further (to the pre-globalowner-task-tree state, for instance), use the older renamed containers: `openclaw-gateway-pre-globalowner`, `openclaw-gateway-old-tasks-phase-5`, `openclaw-gateway-backup-pre-extrapolation`.

## Disk pressure

The VM root is 38GB. Each openclaw image is ~3.3GB; we keep a few tags around for rollback. If `df -h /` shows >90% used:

```bash
docker builder prune -af              # build cache (~12GB if untouched in a while)
docker image prune -f                 # untagged/dangling images
# More aggressive (irreversible): remove specific old rollback tags
docker rmi ghcr.io/openclaw/openclaw:2026.5.12   # last public-image deploy; ~3.3GB
```

Don't `docker image prune -a -f` blindly — it'd wipe rollback tags too.

## Related

- `deploy/fly.private.toml` — unrelated fly.io deploy for a different surface.
- `skills/gog/SKILL.md` — agent-facing command reference for gog (Gmail / Calendar / Drive / Docs / Sheets / Contacts).
- Upstream openclaw deploy memory: `cass-openclaw-deployment` (Claude memory, not in repo).
