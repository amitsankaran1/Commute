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
  g:     'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
};

// ── Travel time estimates in minutes ─────────────────────────────────
// Tune these to match your actual experience.
const T = {
  walkHomeToBergen:   6,   // 331 Clinton St → Bergen St station
  walkHomeToJaySt:   15,   // 331 Clinton St → Jay St-MetroTech (walk fallback)
  fRide:              3,   // F: Bergen St → Jay St-MetroTech (1 stop)
  gRide:              3,   // G: Bergen St → Hoyt-Schermerhorn (1 stop)
  xferJaySt:          2,   // F → A/C transfer at Jay St
  xferHoyt:           2,   // G → A/C transfer at Hoyt-Schermerhorn
  acFromJaySt:       10,   // A/C: Jay St → Canal St
  acFromHoyt:        13,   // A/C: Hoyt-Schermerhorn → Canal St
  walkCanalToOffice:  3,   // Canal St A/C exit → 75 Varick St
};

// FROM OFFICE — raw departures from Canal St
const FROM_OFFICE = [
  {
    label: 'Canal St',
    subtitle: '1 · 2 · 3 · Uptown',
    stopIds: ['120N'],
    routes: ['1', '2', '3'],
    feedKey: '123',
    color: '#EE352E',
  },
  {
    label: 'Canal St',
    subtitle: 'A · C · Downtown → Jay St for F',
    stopIds: ['A32S'],
    routes: ['A', 'C'],
    feedKey: 'ace',
    color: '#2850AD',
  },
];

async function fetchFeed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MTA feed error: ${res.status} ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
}

// Returns sorted list of upcoming train timestamps at given stops
function upcoming(feed, stopIds, allowedRoutes) {
  const now = Math.floor(Date.now() / 1000);
  const results = [];

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    const { trip, stopTimeUpdate } = entity.tripUpdate;
    const route = trip.routeId;
    if (!allowedRoutes.includes(route)) continue;

    for (const stu of stopTimeUpdate) {
      if (!stopIds.includes(stu.stopId)) continue;
      const t = stu.departure?.time || stu.arrival?.time;
      if (!t) continue;
      const ts = typeof t === 'object' ? t.low || t.toNumber() : Number(t);
      if (ts < now - 30 || ts > now + 90 * 60) continue;
      results.push({ route, ts });
    }
  }

  results.sort((a, b) => a.ts - b.ts);
  return results;
}

function computePlans(feeds) {
  const now = Math.floor(Date.now() / 1000);

  const fTrains    = upcoming(feeds.bdfm, ['F20N'], ['F']);
  const gTrains    = upcoming(feeds.g,    ['F20N'], ['G']);
  const acAtJay    = upcoming(feeds.ace,  ['A41N'], ['A', 'C']);
  const acAtHoyt   = upcoming(feeds.ace,  ['A42N'], ['A', 'C']);

  const plans = [];

  // Route: F → A/C via Jay St
  for (const f of fTrains) {
    const readyAtJay = f.ts + (T.fRide + T.xferJaySt) * 60;
    const ac = acAtJay.find(t => t.ts >= readyAtJay);
    if (!ac) continue;

    const officeTs  = ac.ts + (T.acFromJaySt + T.walkCanalToOffice) * 60;
    const leaveInMin = Math.round((f.ts - T.walkHomeToBergen * 60 - now) / 60);
    if (leaveInMin < -3) continue; // already gone

    plans.push({
      routeLabel: 'F → A/C',
      leaveInMin,
      officeTs,
      legs: [
        { kind: 'walk',     label: 'Walk to Bergen St',        mins: T.walkHomeToBergen },
        { kind: 'train',    route: f.route,  label: 'Bergen St → Jay St', mins: T.fRide,        ts: f.ts  },
        { kind: 'transfer', label: 'Transfer to A/C at Jay St',            mins: T.xferJaySt    },
        { kind: 'train',    route: ac.route, label: 'Jay St → Canal St',  mins: T.acFromJaySt, ts: ac.ts },
        { kind: 'walk',     label: 'Walk to 75 Varick',         mins: T.walkCanalToOffice },
      ],
    });
  }

  // Route: G → A/C via Hoyt-Schermerhorn
  for (const g of gTrains) {
    const readyAtHoyt = g.ts + (T.gRide + T.xferHoyt) * 60;
    const ac = acAtHoyt.find(t => t.ts >= readyAtHoyt);
    if (!ac) continue;

    const officeTs   = ac.ts + (T.acFromHoyt + T.walkCanalToOffice) * 60;
    const leaveInMin = Math.round((g.ts - T.walkHomeToBergen * 60 - now) / 60);
    if (leaveInMin < -3) continue;

    plans.push({
      routeLabel: 'G → A/C',
      leaveInMin,
      officeTs,
      legs: [
        { kind: 'walk',     label: 'Walk to Bergen St',                    mins: T.walkHomeToBergen },
        { kind: 'train',    route: g.route,  label: 'Bergen St → Hoyt',   mins: T.gRide,        ts: g.ts  },
        { kind: 'transfer', label: 'Transfer to A/C at Hoyt',              mins: T.xferHoyt     },
        { kind: 'train',    route: ac.route, label: 'Hoyt → Canal St',     mins: T.acFromHoyt,  ts: ac.ts },
        { kind: 'walk',     label: 'Walk to 75 Varick',                    mins: T.walkCanalToOffice },
      ],
    });
  }

  // Sort all plans by arrival time, keep top 2 as Plan A / Plan B
  plans.sort((a, b) => a.officeTs - b.officeTs);
  const top2 = plans.slice(0, 2).map((p, i) => ({ ...p, rank: i === 0 ? 'A' : 'B' }));

  // Walk fallback: leave now, walk to Jay St, catch next A/C
  const walkReadyAtJay = now + T.walkHomeToJaySt * 60;
  const acWalk = acAtJay.find(t => t.ts >= walkReadyAtJay);
  const walkFallback = acWalk ? {
    routeLabel: 'Walk → A/C',
    leaveInMin: 0,
    officeTs: acWalk.ts + (T.acFromJaySt + T.walkCanalToOffice) * 60,
    legs: [
      { kind: 'walk',  label: 'Walk to Jay St-MetroTech', mins: T.walkHomeToJaySt },
      { kind: 'train', route: acWalk.route, label: 'Jay St → Canal St', mins: T.acFromJaySt, ts: acWalk.ts },
      { kind: 'walk',  label: 'Walk to 75 Varick',        mins: T.walkCanalToOffice },
    ],
  } : null;

  return { plans: top2, walkFallback, fetchedAt: Date.now() };
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
      arrivals.push({ route, minsAway, direction: stu.stopId.endsWith('N') ? 'Northbound' : 'Southbound', timestamp: seconds });
    }
  }

  arrivals.sort((a, b) => a.timestamp - b.timestamp);
  return arrivals.slice(0, 8);
}

app.use(express.static(path.join(__dirname, 'public')));

// Morning: computed plans
app.get('/api/plans', async (req, res) => {
  try {
    const [bdfm, g, ace] = await Promise.all([
      fetchFeed(FEEDS.bdfm),
      fetchFeed(FEEDS.g),
      fetchFeed(FEEDS.ace),
    ]);
    res.json(computePlans({ bdfm, g, ace }));
  } catch (err) {
    console.error('Plans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Evening: raw departures
app.get('/api/departures', async (req, res) => {
  try {
    const feedKeys = [...new Set(FROM_OFFICE.map(s => s.feedKey))];
    const feedMap = {};
    await Promise.all(feedKeys.map(async key => { feedMap[key] = await fetchFeed(FEEDS[key]); }));

    const stations = FROM_OFFICE.map(cfg => ({
      label: cfg.label,
      subtitle: cfg.subtitle,
      color: cfg.color,
      arrivals: parseArrivals(feedMap[cfg.feedKey], cfg.stopIds, cfg.routes),
    }));

    res.json({ stations, fetchedAt: Date.now() });
  } catch (err) {
    console.error('Departures error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`NYC Commute Board → http://localhost:${PORT}`));
