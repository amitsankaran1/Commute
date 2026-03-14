# NYC Commute Board

Real-time departure board for the commute from **331 Clinton St, Brooklyn → 75 Varick St, Manhattan**.

Shows next trains at:
- **Bergen Street** — F train (northbound toward Manhattan)
- **Canal Street** — 1, 2, 3 trains
- **Canal Street** — A, C trains

Auto-refreshes every 30 seconds.

## Setup

```bash
npm install
node server.js
# → http://localhost:3000
```

## How it works

Fetches live GTFS-RT protobuf feeds from the MTA:
- `gtfs-bdfm` → F train at Bergen St (`F20N`)
- `gtfs` → 1/2/3 trains at Canal St (`120N` / `120S`)
- `gtfs-ace` → A/C trains at Canal St (`A32N` / `A32S`)
