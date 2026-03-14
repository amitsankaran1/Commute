# NYC Commute Board

Real-time departure board for the commute from **331 Clinton St, Brooklyn → 75 Varick St, Manhattan**.

Shows next trains at:
- **Bergen Street** — F train (northbound toward Manhattan)
- **Canal Street** — 1, 2, 3 trains
- **Canal Street** — A, C trains

Auto-refreshes every 30 seconds.

## Setup

1. Get a free MTA API key at https://api.mta.info/
2. Install dependencies:
   ```
   npm install
   ```
3. Start the server with your key:
   ```
   MTA_API_KEY=your_key_here node server.js
   ```
4. Open http://localhost:3000

## How it works

Fetches live GTFS-RT protobuf feeds from the MTA:
- `gtfs-bdfm` for the F train
- `gtfs-ace` for the A/C trains
- `gtfs` (numbered lines) for the 1/2/3 trains

Parses stop arrivals for:
- `F20N` — Bergen Street, northbound
- `120N` / `120S` — Canal Street 1/2/3
- `A32N` / `A32S` — Canal Street A/C
