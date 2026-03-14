const express = require('express');
const fetch = require('node-fetch');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const FEEDS = {
  bdfm:  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  ace:   'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  '123': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
};

// TO OFFICE — depart Bergen St, arrive Canal St
const TO_OFFICE = [
  {
    label: 'Bergen St',
    subtitle: 'F · Northbound to Manhattan',
    stopIds: ['F20N'],
    routes: ['F'],
    feedKey: 'bdfm',
    color: '#FF6319',
  },
  {
    label: 'Canal St',
    subtitle: '1 · 2 · 3',
    stopIds: ['120N', '120S'],
    routes: ['1', '2', '3'],
    feedKey: '123',
    color: '#EE352E',
  },
  {
    label: 'Canal St',
    subtitle: 'A · C',
    stopIds: ['A32N', 'A32S'],
    routes: ['A', 'C'],
    feedKey: 'ace',
    color: '#2850AD',
  },
];

// FROM OFFICE — depart Canal St, arrive Bergen St
const FROM_OFFICE = [
  {
    label: 'Canal St',
    subtitle: 'A · C · Southbound → Jay St',
    stopIds: ['A32S'],
    routes: ['A', 'C'],
    feedKey: 'ace',
    color: '#2850AD',
  },
  {
    label: 'Canal St',
    subtitle: '1 · 2 · 3 · Southbound',
    stopIds: ['120S'],
    routes: ['1', '2', '3'],
    feedKey: '123',
    color: '#EE352E',
  },
  {
    label: 'Bergen St',
    subtitle: 'F · Southbound to Brooklyn',
    stopIds: ['F20S'],
    routes: ['F'],
    feedKey: 'bdfm',
    color: '#FF6319',
  },
];

async function fetchFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MTA feed error: ${res.status} ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
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
  const mode = req.query.mode === 'from' ? 'from' : 'to';
  const config = mode === 'from' ? FROM_OFFICE : TO_OFFICE;

  try {
    const feedKeys = [...new Set(config.map((s) => s.feedKey))];
    const feedMap = {};
    await Promise.all(
      feedKeys.map(async (key) => {
        feedMap[key] = await fetchFeed(FEEDS[key]);
      })
    );

    const stations = config.map((cfg) => ({
      label: cfg.label,
      subtitle: cfg.subtitle,
      color: cfg.color,
      arrivals: parseArrivals(feedMap[cfg.feedKey], cfg.stopIds, cfg.routes),
    }));

    res.json({ stations, mode, fetchedAt: Date.now() });
  } catch (err) {
    console.error('Feed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`NYC Commute Board → http://localhost:${PORT}`);
});
