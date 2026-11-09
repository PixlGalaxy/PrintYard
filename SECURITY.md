# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/PixlGalaxy/SliceDock/security/advisories/new) instead.
Include steps to reproduce, the affected version (shown in the footer) and the impact.

## Scope

SliceDock controls a physical machine that heats up and moves. Reports about any of these are especially welcome:

- Bypassing authentication or role checks (a regular user acting as admin, or bypassing filament limits / approval).
- Running the first-run setup from outside the local network.
- Reaching the printer's unauthenticated APIs (Moonraker, Creality WebSocket) through SliceDock without being logged in.
- Path traversal or code execution through uploaded models, G-code or 3MF files.

## Deployment notes

- Always put SliceDock behind HTTPS when exposed to the internet.
- Never expose the printer's ports (80, 4408, 7125, 9999) directly — they have no authentication.
