const express = require('express');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MTA_API_KEY = process.env.MTA_API_KEY || '';

// MTA GTFS-RT feed URLs
const FEEDS = {
  bdfm: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm', // F train
  ace:  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',   // A, C trains
  nqrw: 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',  // not needed but added
  '123': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',      // 1, 2, 3 trains
};

// Stop IDs (NYCT GTFS convention: stopId + "N" northbound, "S" southbound)
// Bergen Street F — northbound toward Manhattan
// Canal Street 1/2/3 — stop 120, show northbound (uptown) + southbound (downtown)
// Canal Street A/C — stop A32, show both directions
const STOPS_CONFIG = [
  {
    label: 'Bergen St',
    subtitle: 'F train · Northbound to Manhattan',
    stopIds: ['F20N'],
    routes: ['F'],
    feedKey: 'bdfm',
    color: '#FF6319',
  },
  {
    label: 'Canal St',
    subtitle: '1 · 2 · 3 trains',
    stopIds: ['120N', '120S'],
    routes: ['1', '2', '3'],
    feedKey: '123',
    color: '#EE352E',
  },
  {
    label: 'Canal St',
    subtitle: 'A · C trains',
    stopIds: ['A32N', 'A32S'],
    routes: ['A', 'C'],
    feedKey: 'ace',
    color: '#2850AD',
  },
];

async function fetchFeed(url) {
  const headers = {};
  if (MTA_API_KEY) headers['x-api-key'] = MTA_API_KEY;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`MTA feed error: ${res.status} ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(buffer)
  );
}

function parseArrivals(feed, stopIds, allowedRoutes) {
  const now = Math.floor(Date.now() / 1000);
  const arrivals = [];

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    const { trip, stopTimeUpdate } = entity.tripUpdate;
    const route = trip.routeId;
    if (!allowedRoutes.includes(route)) continue;

    for (const stu of stopTimeUpdate) {
      if (!stopIds.includes(stu.stopId)) continue;
      const t = stu.departure?.time || stu.arrival?.time;
      if (!t) continue;

      const seconds = typeof t === 'object' ? t.low || t.toNumber() : Number(t);
      const minsAway = Math.round((seconds - now) / 60);
      if (minsAway < 0 || minsAway > 60) continue;

      arrivals.push({
        route,
        minsAway,
        stopId: stu.stopId,
        direction: stu.stopId.endsWith('N') ? 'Northbound' : 'Southbound',
        timestamp: seconds,
      });
    }
  }

  arrivals.sort((a, b) => a.timestamp - b.timestamp);
  return arrivals.slice(0, 8);
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/departures', async (req, res) => {
  if (!MTA_API_KEY) {
    return res.status(400).json({
      error: 'MTA_API_KEY not set. Set the environment variable and restart.',
    });
  }

  try {
    // Fetch needed feeds in parallel
    const feedKeys = [...new Set(STOPS_CONFIG.map((s) => s.feedKey))];
    const feedMap = {};
    await Promise.all(
      feedKeys.map(async (key) => {
        feedMap[key] = await fetchFeed(FEEDS[key]);
      })
    );

    const stations = STOPS_CONFIG.map((cfg) => ({
      label: cfg.label,
      subtitle: cfg.subtitle,
      color: cfg.color,
      arrivals: parseArrivals(feedMap[cfg.feedKey], cfg.stopIds, cfg.routes),
    }));

    res.json({ stations, fetchedAt: Date.now() });
  } catch (err) {
    console.error('Feed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\nNYC Commute Board running at http://localhost:${PORT}`);
  if (!MTA_API_KEY) {
    console.log('\n⚠  MTA_API_KEY is not set!');
    console.log('   Get a free key at https://api.mta.info/');
    console.log('   Then run: MTA_API_KEY=your_key node server.js\n');
  }
});
