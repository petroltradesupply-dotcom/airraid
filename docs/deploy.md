# Deploying

## What runs

An `nginx:1.27-alpine` container serving `web/` read-only, with a reverse proxy in front
terminating TLS. The container publishes no host ports: the proxy reaches it by name over a
shared Docker network, so the only way in is the public hostname.

```sh
docker compose -p airraid up -d
```

Two things in that compose file assume a particular deployment:

- the external `edge` network, which is how the proxy reaches the container;
- `STATUS_DIR`, which points at the directory a separate alert daemon writes
  `status.json` into, and is set in a `.env` beside the compose file.

Drop the network, publish a port instead, leave `STATUS_DIR` unset, and the page serves
standalone — with the status panel reporting that the verdict is unavailable, which it
honestly is.

## TLS

Caddy holds `:443` and obtains a certificate automatically:

```
airraid.pp.ua {
    encode gzip zstd
    reverse_proxy airraid-web:80
}
```

Nothing else is needed. Two routes were tried first and are worth recording, because both
look plausible and neither works.

**Cloudflare Tunnel.** Would have avoided opening any inbound port. Zero Trust now requires
a payment method on file even on the free plan, so it was abandoned.

**Cloudflare's ordinary proxy to a non-standard origin port.** The published list of
supported ports describes which ports a *visitor* may use; Cloudflare then connects to the
origin on that same port. It cannot serve `:443` to a visitor and fetch from `:8443` at the
origin — that is Origin Rules → Destination Port, which is Enterprise only. A proxied
request to `:443` therefore reached the reverse proxy, which did not know the hostname and
refused the handshake, producing a `525` that looks like a certificate problem and is not.

`https://airraid.pp.ua:8443/` did work, because there the visitor's port and the origin
port are the same. The port in the address was the reason to stop and let Caddy own `:443`
instead.

## DNS

Delegated to the registrar's own nameservers with a single `A` record for the apex and one
for `www`. Cloudflare sat in front for a while and was removed: it hid nothing, since other
sites on the same address resolve directly, and it added a layer to something that has to
work at night.

## Updating the page

```sh
rsync -a --exclude live/ web/ user@host:/opt/airraid/web/
```

No restart needed — nginx serves the files from a bind-mounted directory.

**One trap.** `rsync` replaces a file by writing a new inode and renaming over it, and a
bind mount of a *single file* follows the inode rather than the path. A config file updated
that way leaves the container reading the old contents, and a reload reports the config as
unchanged. Directories are fine, which is why `web/` syncs cleanly and a mounted
`nginx.conf` does not. For single files, `docker cp` into the container or recreate it.

## Before pushing a change

```sh
python3 tools/check_web.py
```

Any asset under `web/` that changed needs its `?v=` hash in `index.html` updated to the
first eight characters of the file's SHA-1. CI fails the push otherwise, which is the point:
nginx caches assets for a week, so a stale hash means a shipped fix that nobody sees.
