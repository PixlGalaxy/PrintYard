<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
  <img src="docs/logo.svg" alt="PrintYard" width="344" height="100">
</picture>

# PrintYard

**Self-hosted web panel and slicer for your 3D printer — slice, print and monitor from any browser.**

</div>

> PrintYard is a community project. It is compatible with Creality printers but is **not affiliated with or endorsed by Creality**.

> Early development. Expect breaking changes until the first release.

## Features

- **Browser slicer** — place models on the bed in a 3D view (rendered in your browser), slice on the server with the official **Creality Print** engine (or **OrcaSlicer**), preview the G-code and print.
- **Official profiles** — uses Creality's own printer, process and filament profiles.
- **Live printer control** — status, temperatures, progress, pause/resume/cancel, CFS multi-material.
- **Users and limits** — admin and regular users; per-user filament limits (grams per print / per month), max print time, admin approval, cost per kg. Limits can be turned off per user.
- **File library** — private by default, with a shared library to publish models.
- **Notifications** — Discord, Telegram, ntfy, generic webhook, and push notifications on phones (iOS home-screen app) and browsers.
- **Secure by default** — the panel is the only door to your printer; first-run setup is only allowed from your local network.
- **English and Spanish.**

### Supported printers

| Printer | Status |
|---|---|
| Creality K2 SE | In development |

New printers are added as drivers — contributions welcome.

## Running it

PrintYard runs as **one container** (x86_64).

```sh
docker run -d \
  --name printyard \
  --restart unless-stopped \
  --memory 2g \
  -p 3000:3000 \
  -e PUID=99 -e PGID=100 -e TZ=America/New_York \
  -v /path/to/appdata:/appdata \
  -v /path/to/data:/data \
  ghcr.io/pixlgalaxy/printyard:latest
```

Then open `http://<server-lan-ip>:3000` **from your local network** to run the setup wizard.

> **Finish the setup wizard before exposing PrintYard to the internet.** Until an admin account exists, whoever reaches the setup page first can create it. PrintYard blocks setup requests that come through Cloudflare or a reverse proxy that sends `X-Forwarded-*` headers, but a plain TCP tunnel or a proxy that strips those headers cannot be told apart from a local visitor. Do not publish the port, tunnel or proxy host until setup is complete.

### Dynamic printer IP (find by MAC)

If your printer does not have a static IP, PrintYard can find it by its MAC address. That requires host networking so the container can see your LAN:

```sh
docker run -d --name printyard --network host -e PORT=3000 ... ghcr.io/pixlgalaxy/printyard:latest
```

### Volumes

| Path | Contents |
|---|---|
| `/appdata` | Database, settings, avatars, logs, slicer engine |
| `/data` | Your models and G-code (STL, 3MF, G-code) |

### Memory

The panel idles at around 150 MB, but slicing needs much more while it runs. **Give the container more than 1 GB** (`--memory 2g` recommended; large models with tree supports may need 3–4 GB). The admin panel warns you if the limit is too low.

### Upgrading from SliceDock

PrintYard was called SliceDock before. Existing installs keep working with no manual steps:

- Switch the image to `ghcr.io/pixlgalaxy/printyard` and keep the same `/appdata` and `/data` volumes. On first start, `appdata/slicedock.db` is renamed to `printyard.db`.
- Environment variables are now `PRINTYARD_*`. The old `SLICEDOCK_*` names are still read, but they are deprecated.
- Webhooks send `X-PrintYard-Event` and `X-PrintYard-Signature`. For now they also send the old `X-SliceDock-Event` and `X-SliceDock-Signature` headers with the same values. Those are deprecated, so update your receivers.
- Projects saved by SliceDock (3MF) and profile backups stored on the printer still open.

## Exposing it to the internet

Always use **HTTPS** from the outside (push notifications on iOS require it). The setup wizard asks how PrintYard is exposed so it can read the real client IP:

- **Cloudflare Tunnel** — uses `CF-Connecting-IP`.
- **Nginx / Nginx Proxy Manager** — uses `X-Real-IP` / `X-Forwarded-For`. Enable *Websockets Support* in NPM.
- **Other** — configure your trusted proxies in the admin panel.

**Never expose the printer's own ports** (80, 4408, 7125, 9999) to the internet: they have no authentication. PrintYard proxies everything with auth.

## Development

```sh
cd backend && npm install && npm run dev     # API on http://localhost:3000
cd frontend && npm install && npm run dev    # UI on http://localhost:5173 (proxies /api)
```

## Credits

PrintYard stands on the shoulders of open-source slicers:
[Creality Print](https://github.com/CrealityOfficial/CrealityPrint) ·
[OrcaSlicer](https://github.com/SoftFever/OrcaSlicer) ·
[Bambu Studio](https://github.com/bambulab/BambuStudio) ·
[PrusaSlicer](https://github.com/prusa3d/PrusaSlicer) ·
[Slic3r](https://github.com/slic3r/Slic3r).
Thanks to the Creality Print team and the whole community.

## License

[AGPL-3.0](LICENSE). If you run a modified PrintYard for other people, you must share your changes.
