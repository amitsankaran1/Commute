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

// ── Travel time estimates (minutes) ──────────────────────────────────
const T = {
  walkHomeToBergen:   6,   // 331 Clinton St → Bergen St station
  walkHomeToJaySt:   15,   // 331 Clinton St → Jay St-MetroTech (walk fallback)
  fRide:              3,   // F: Bergen St → Jay St (1 stop)
  gRide:              3,   // G: Bergen St → Hoyt-Schermerhorn (1 stop)
  xferJaySt:          1,   // F→A/C at Jay St: walk across platform, negligible
  xferHoyt:           3,   // G→A/C at Hoyt: harder transfer
  acFromJaySt:       10,   // A/C: Jay St → Canal St
  acFromHoyt:        13,   // A/C: Hoyt-Schermerhorn → Canal St
  walkCanalToOffice:  3,   // Canal St A/C → 75 Varick St
};

// G is only shown as Plan B if it arrives within this many minutes of Plan A.
// Outside this window it's too slow to be worth the harder Hoyt transfer.
const PLAN_B_MAX_DELTA_MINS = 5;

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

function buildFPlan(f, acAtJay, now) {
  const arrivalAtJay = f.ts + T.fRide * 60;
  const ac = acAtJay.find(t => t.ts >= arrivalAtJay + T.xferJaySt * 60);
  if (!ac) return null;
  const officeTs = ac.ts + (T.acFromJaySt + T.walkCanalToOffice) * 60;
  const leaveInMin = Math.round((f.ts - T.walkHomeToBergen * 60 - now) / 60);
  if (leaveInMin < -3) return null;
  return {
    routeLabel: 'F → A/C',
    leaveInMin,
    officeTs,
    legs: [
      { kind: 'walk',  label: 'Walk to Bergen St',   mins: T.walkHomeToBergen },
      { kind: 'train', route: 'F',       label: 'Bergen St → Jay St',  mins: T.fRide,        ts: f.ts  },
      { kind: 'train', route: ac.route,  label: 'Jay St → Canal St',   mins: T.acFromJaySt,  ts: ac.ts },
      { kind: 'walk',  label: 'Walk to 75 Varick',   mins: T.walkCanalToOffice },
    ],
  };
}

function buildGPlan(g, acAtHoyt, now) {
  const readyAtHoyt = g.ts + (T.gRide + T.xferHoyt) * 60;
  const ac = acAtHoyt.find(t => t.ts >= readyAtHoyt);
  if (!ac) return null;
  const officeTs = ac.ts + (T.acFromHoyt + T.walkCanalToOffice) * 60;
  const leaveInMin = Math.round((g.ts - T.walkHomeToBergen * 60 - now) / 60);
  if (leaveInMin < -3) return null;
  return {
    routeLabel: 'G → A/C',
    leaveInMin,
    officeTs,
    legs: [
      { kind: 'walk',     label: 'Walk to Bergen St',            mins: T.walkHomeToBergen },
      { kind: 'train',    route: 'G',       label: 'Bergen St → Hoyt',  mins: T.gRide,       ts: g.ts  },
      { kind: 'transfer', label: 'Transfer to A/C at Hoyt',     mins: T.xferHoyt },
      { kind: 'train',    route: ac.route,  label: 'Hoyt → Canal St',   mins: T.acFromHoyt,  ts: ac.ts },
      { kind: 'walk',     label: 'Walk to 75 Varick',            mins: T.walkCanalToOffice },
    ],
  };
}

function computePlans(feeds) {
  const now = Math.floor(Date.now() / 1000);

  const fTrains  = upcoming(feeds.bdfm, ['F20N'], ['F']);
  const gTrains  = upcoming(feeds.g,    ['F20N'], ['G']);
  const acAtJay  = upcoming(feeds.ace,  ['A41N'], ['A', 'C']);
  const acAtHoyt = upcoming(feeds.ace,  ['A42N'], ['A', 'C']);

  // Build first two valid F plans (current train + next train)
  const fPlans = [];
  for (const f of fTrains) {
    const plan = buildFPlan(f, acAtJay, now);
    if (plan) fPlans.push(plan);
    if (fPlans.length >= 2) break;
  }

  // Build best G plan
  let gPlan = null;
  for (const g of gTrains) {
    const plan = buildGPlan(g, acAtHoyt, now);
    if (plan) { gPlan = plan; break; }
  }

  // Determine Plan A (F primary), Plan A next (following F), Plan B (G if viable)
  const fBest = fPlans[0] || null;
  const fNext = fPlans[1] || null;

  let planA = null, planANext = null, planB = null, planBDeltaMins = null;

  if (fBest && gPlan) {
    planBDeltaMins = Math.round((gPlan.officeTs - fBest.officeTs) / 60);

    if (planBDeltaMins < 0) {
      // G is actually faster — G becomes Plan A, F is Plan B
      planA     = { ...gPlan, rank: 'A' };
      planANext = null;
      planB     = Math.abs(planBDeltaMins) <= PLAN_B_MAX_DELTA_MINS
        ? { ...fBest, rank: 'B', deltaMinutes: Math.abs(planBDeltaMins) }
        : null;
      planBDeltaMins = Math.abs(planBDeltaMins);
    } else {
      // F is faster or same
      planA     = { ...fBest, rank: 'A' };
      planANext = fNext;
      planB     = planBDeltaMins <= PLAN_B_MAX_DELTA_MINS
        ? { ...gPlan, rank: 'B', deltaMinutes: planBDeltaMins }
        : null;
    }
  } else if (fBest) {
    planA     = { ...fBest, rank: 'A' };
    planANext = fNext;
  } else if (gPlan) {
    // F totally down
    planA = { ...gPlan, rank: 'A' };
  }

  // Walk fallback: leave now, walk 15 min to Jay St
  const walkReadyAtJay = now + T.walkHomeToJaySt * 60;
  const acWalk = acAtJay.find(t => t.ts >= walkReadyAtJay);
  const walkFallback = acWalk ? {
    officeTs: acWalk.ts + (T.acFromJaySt + T.walkCanalToOffice) * 60,
    acRoute:  acWalk.route,
    acTs:     acWalk.ts,
  } : null;

  return { planA, planANext, planB, planBDeltaMins, walkFallback, fetchedAt: Date.now() };
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

// ── Weather ──────────────────────────────────────────────────────────
// 331 Clinton St, Carroll Gardens
const WEATHER_LAT = 40.6793;
const WEATHER_LON = -73.9990;

const WMO_LABELS = {
  0:  ['☀️',  'Clear'],
  1:  ['🌤️', 'Mainly clear'],
  2:  ['⛅',  'Partly cloudy'],
  3:  ['☁️',  'Overcast'],
  45: ['🌫️', 'Foggy'],
  48: ['🌫️', 'Icy fog'],
  51: ['🌦️', 'Light drizzle'],
  53: ['🌦️', 'Drizzle'],
  55: ['🌦️', 'Heavy drizzle'],
  61: ['🌧️', 'Light rain'],
  63: ['🌧️', 'Rain'],
  65: ['🌧️', 'Heavy rain'],
  71: ['🌨️', 'Light snow'],
  73: ['🌨️', 'Snow'],
  75: ['🌨️', 'Heavy snow'],
  80: ['🌧️', 'Showers'],
  81: ['🌧️', 'Showers'],
  82: ['🌧️', 'Heavy showers'],
  95: ['⛈️',  'Thunderstorm'],
  96: ['⛈️',  'Thunderstorm'],
  99: ['⛈️',  'Thunderstorm'],
};

function wmoLabel(code) {
  return WMO_LABELS[code] ?? ['🌡️', `Code ${code}`];
}

// Walk is good if: no meaningful precip, not too windy, no rain/snow codes
function walkAssessment(tempF, precipIn, windMph, wmoCode) {
  if (wmoCode >= 51)    return { verdict: 'skip',  label: 'Wet out — take the train' };
  if (precipIn >= 0.01) return { verdict: 'skip',  label: 'Precipitation — take the train' };
  if (windMph  >= 25)   return { verdict: 'skip',  label: 'Very windy — take the train' };
  if (tempF    <= 20)   return { verdict: 'skip',  label: 'Too cold — take the train' };
  if (windMph  >= 18)   return { verdict: 'ok',    label: 'Windy but walkable' };
  if (tempF    <= 35)   return { verdict: 'ok',    label: 'Cold but walkable' };
  return                       { verdict: 'great', label: 'Nice out — worth the walk' };
}

app.get('/api/weather', async (req, res) => {
  try {
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}` +
      `&current=temperature_2m,precipitation,weathercode,windspeed_10m` +
      `&temperature_unit=fahrenheit&windspeed_unit=mph&precipitation_unit=inch` +
      `&timezone=America%2FNew_York`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
    const json = await r.json();
    const c = json.current;
    const tempF    = Math.round(c.temperature_2m);
    const precipIn = c.precipitation;
    const windMph  = Math.round(c.windspeed_10m);
    const wmoCode  = c.weathercode;
    const [icon, condition] = wmoLabel(wmoCode);
    res.json({
      tempF, precipIn, windMph, wmoCode,
      icon, condition,
      walk: walkAssessment(tempF, precipIn, windMph, wmoCode),
      fetchedAt: Date.now(),
    });
  } catch (err) {
    console.error('Weather error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/departures', async (req, res) => {
  try {
    const feedKeys = [...new Set(FROM_OFFICE.map(s => s.feedKey))];
    const feedMap = {};
    await Promise.all(feedKeys.map(async key => { feedMap[key] = await fetchFeed(FEEDS[key]); }));
    const stations = FROM_OFFICE.map(cfg => ({
      label: cfg.label, subtitle: cfg.subtitle, color: cfg.color,
      arrivals: parseArrivals(feedMap[cfg.feedKey], cfg.stopIds, cfg.routes),
    }));
    res.json({ stations, fetchedAt: Date.now() });
  } catch (err) {
    console.error('Departures error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`NYC Commute Board → http://localhost:${PORT}`));
