# Deploying the directory

The directory is a tiny Node service. It runs anywhere Node 24+ does. For a
home setup it can ride an existing Raspberry Pi + Cloudflare Tunnel as its own
service on a separate port and hostname.

> **Reliability note.** The directory's whole job is to be the always-on
> rendezvous point. Running it on a home Pi is fine to bootstrap a friend group,
> but once it serves people beyond a test circle, move it to an always-on host
> (a small VPS) — a home box rebooting takes the whole network's coordination
> down. The steps below are identical on a VPS; only the tunnel part differs.

## 1. Get the code on the box

```bash
cd ~
git clone https://github.com/arin-jaff/TrainingGeeks-Directory.git
cd TrainingGeeks-Directory
npm ci
```

## 2. systemd service

Create `/etc/systemd/system/tg-directory.service` (adjust `User` and paths):

```ini
[Unit]
Description=TrainingGeeks Directory
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/TrainingGeeks-Directory
Environment=PORT=4000
Environment=TG_DIRECTORY_DB=/home/pi/TrainingGeeks-Directory/data/directory.db
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tg-directory
curl localhost:4000/health   # {"ok":true,...}
```

## 3. Expose it via the existing Cloudflare Tunnel

You do **not** need a second tunnel — add a hostname to the one already running
the app. In `~/.cloudflared/config.yml`, add an ingress rule **above** the
catch-all 404:

```yaml
ingress:
  - hostname: traininggeeks.arinjaff.com
    service: http://localhost:3000
  - hostname: directory.arinjaff.com      # <-- add this
    service: http://localhost:4000
  - service: http_status:404
```

Route the new hostname and restart:

```bash
cloudflared tunnel route dns <tunnel-name> directory.arinjaff.com
sudo systemctl restart cloudflared
curl https://directory.arinjaff.com/health
```

## 4. Point your TrainingGeeks instance at it

On the **app** box, set these and restart the app:

```
TG_DIRECTORY_URL=https://directory.arinjaff.com
TG_PUBLIC_URL=https://traininggeeks.arinjaff.com
```

Then open the app's **Social** tab to claim a handle. To keep presence fresh,
set up the heartbeat timer (see the app repo's `DEPLOYMENT.md` → Federation
heartbeat).

## Checks

```bash
systemctl status tg-directory --no-pager
journalctl -u tg-directory -f
```
