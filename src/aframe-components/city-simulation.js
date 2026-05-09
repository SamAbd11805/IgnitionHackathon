/* city-simulation.js
 * A-Frame components for a small agent-based crime simulation.
 *   citizen-agent     – pedestrian that walks the sidewalk graph
 *   police-agent      – patrol car that follows lane waypoints
 *   city-simulation   – orchestrator: spawns the city + agents
 *
 * Coord system: +x = east, -z = north, ground at y=0.
 * Roads at center of scene (intersection at origin).
 */

// ── helpers ─────────────────────────────────────────────────────────────────
const rand = (a, b) => a + Math.random() * (b - a);
const dist2D = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
const SPAWN_CLASS = 'crime-sim-spawned';

// 16-colour palette used to identify routes + cars (each police car's pillar
// is coloured to match its assigned route's debug dots).
const ROUTE_COLOR_PALETTE = [
  '#00ffff',
  '#ff00ff',
  '#ffee00',
  '#ff6600',
  '#00ff66',
  '#ff0066',
  '#9966ff',
  '#66ffff',
  '#ff44aa',
  '#44ff44',
  '#ffaa44',
  '#44aaff',
  '#ff8866',
  '#88ff88',
  '#cc66ff',
  '#ffcc44'
];

const CS = {
  WANDERING: 'wandering',
  FLEEING: 'fleeing',
  DEAD: 'dead',
  ARRESTED: 'arrested'
};
const PS = {
  PATROLLING: 'patrolling',
  RESPONDING: 'responding',
  AT_SCENE: 'at_scene'
};

// ── city geometry constants ────────────────────────────────────────────────
const ROAD_HALF_WIDTH = 4.5; // road is 9 units wide
const SIDEWALK_OUTER = 7.0; // outer edge of sidewalk
const SIDEWALK_CENTER = 5.75; // walking line on the sidewalk
const LANE_OFFSET = 2.25; // distance from center line for each lane
const ROAD_LENGTH = 60;
const NODE_STEP = 5; // distance between sidewalk waypoints
const NODES_PER_ARM = 4; // 4 nodes per sidewalk arm

// ── Build sidewalk graph procedurally ───────────────────────────────────────
function buildSidewalkGraph() {
  const nodes = {};
  const adj = {};
  const add = (id, x, z) => {
    nodes[id] = { x, y: 0, z };
    adj[id] = [];
  };
  const link = (a, b) => {
    if (!adj[a].includes(b)) {
      adj[a].push(b);
    }
    if (!adj[b].includes(a)) {
      adj[b].push(a);
    }
  };

  // 4 intersection corners (where sidewalks meet)
  add('c_NW', -SIDEWALK_CENTER, -SIDEWALK_CENTER);
  add('c_NE', SIDEWALK_CENTER, -SIDEWALK_CENTER);
  add('c_SW', -SIDEWALK_CENTER, SIDEWALK_CENTER);
  add('c_SE', SIDEWALK_CENTER, SIDEWALK_CENTER);

  // Crosswalks across the roads (4 of them)
  link('c_NW', 'c_NE'); // across N-S road, north side
  link('c_SW', 'c_SE'); // across N-S road, south side
  link('c_NW', 'c_SW'); // across E-W road, west side
  link('c_NE', 'c_SE'); // across E-W road, east side

  // 8 sidewalk arms, each with NODES_PER_ARM nodes leading away from a corner
  const arms = [
    ['c_NW', 'wn', -SIDEWALK_CENTER, -SIDEWALK_CENTER, 0, -1], // West arm going north
    ['c_SW', 'ws', -SIDEWALK_CENTER, SIDEWALK_CENTER, 0, 1], // West arm going south
    ['c_NE', 'en', SIDEWALK_CENTER, -SIDEWALK_CENTER, 0, -1], // East arm going north
    ['c_SE', 'es', SIDEWALK_CENTER, SIDEWALK_CENTER, 0, 1], // East arm going south
    ['c_NW', 'nw', -SIDEWALK_CENTER, -SIDEWALK_CENTER, -1, 0], // North arm going west
    ['c_NE', 'ne', SIDEWALK_CENTER, -SIDEWALK_CENTER, 1, 0], // North arm going east
    ['c_SW', 'sw', -SIDEWALK_CENTER, SIDEWALK_CENTER, -1, 0], // South arm going west
    ['c_SE', 'se', SIDEWALK_CENTER, SIDEWALK_CENTER, 1, 0] // South arm going east
  ];
  arms.forEach(([startId, prefix, x0, z0, dx, dz]) => {
    let prev = startId;
    for (let i = 1; i <= NODES_PER_ARM; i++) {
      const id = `${prefix}${i}`;
      add(id, x0 + dx * i * NODE_STEP, z0 + dz * i * NODE_STEP);
      link(prev, id);
      prev = id;
    }
  });

  return { nodes, adj };
}
const GRAPH = buildSidewalkGraph();
// (ALL_NODE_IDS used to be cached here but is now derived per-call from
// the active graph since detection mode swaps the graph at runtime.)

// Project a crime onto the nearest hardcoded-city lane (used as a fallback
// when no 3DStreet drive-lanes are detected in the scene).
function fallbackRoadApproachPoint(crime) {
  const { x, z } = crime;
  if (Math.abs(x) > Math.abs(z)) {
    return { x: x < 0 ? -LANE_OFFSET : LANE_OFFSET, z };
  }
  return { x, z: z < 0 ? -LANE_OFFSET : LANE_OFFSET };
}

// Convert a single drive-lane (array of waypoints) into a ping-pong loop:
// forward through the lane, then back via the interior points. Avoids the
// teleport-on-loop visual glitch you'd get with [start, end] alone.
function laneToRoute(lane) {
  if (!Array.isArray(lane) || lane.length < 2) {
    return lane;
  }
  const back = lane.slice(1, -1).reverse();
  return [...lane, ...back];
}

// ── OSM (OpenStreetMap) fetcher ────────────────────────────────────────────
// When the scene has a 3DStreet <street-geo>, we fetch the real road network
// for that area from OpenStreetMap and use it as the simulation's walkable
// graph + driving lanes. Free, no API key needed (Overpass public endpoint).

// Equirectangular projection — good enough for ≤1 km tiles in any city.
// 3DStreet convention: +x = east, -z = north.
function gpsToLocal(lat, lon, centerLat, centerLon) {
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  return {
    x: (lon - centerLon) * 111320 * cosLat,
    z: -(lat - centerLat) * 111320
  };
}

// Highways that are drivable (police can use them as patrol lanes).
const OSM_DRIVABLE = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'service',
  'living_street',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link'
]);
// Highways pedestrians may walk on (we conflate sidewalk + roadway here for
// hackathon simplicity — citizens walk on the centerline of any path).
const OSM_WALKABLE = new Set([
  'footway',
  'pedestrian',
  'path',
  'living_street',
  'residential',
  'unclassified',
  'service',
  'tertiary',
  'secondary',
  'primary'
]);

async function fetchOSMRoads(centerLat, centerLon, radiusMeters) {
  const latDelta = radiusMeters / 111320;
  const lonDelta =
    radiusMeters / (111320 * Math.cos((centerLat * Math.PI) / 180));
  const south = centerLat - latDelta;
  const north = centerLat + latDelta;
  const west = centerLon - lonDelta;
  const east = centerLon + lonDelta;

  const filter = [...new Set([...OSM_DRIVABLE, ...OSM_WALKABLE])].join('|');
  const ql = `[out:json][timeout:25];
(
  way["highway"~"^(${filter})$"](${south},${west},${north},${east});
);
out geom;`;

  const url =
    'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(ql);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Overpass HTTP ${resp.status}`);
  }
  const json = await resp.json();
  return json.elements || [];
}

// ── OSM full-city fetcher: roads + buildings + water + green areas ──────────
async function fetchOSMCity(centerLat, centerLon, radiusMeters) {
  const latDelta = radiusMeters / 111320;
  const lonDelta =
    radiusMeters / (111320 * Math.cos((centerLat * Math.PI) / 180));
  const south = centerLat - latDelta;
  const north = centerLat + latDelta;
  const west = centerLon - lonDelta;
  const east = centerLon + lonDelta;

  const ql = `[out:json][timeout:60];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|footway|pedestrian|path|cycleway|track)$"](${south},${west},${north},${east});
  way["building"](${south},${west},${north},${east});
  way["natural"="water"](${south},${west},${north},${east});
  way["waterway"](${south},${west},${north},${east});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery)$"](${south},${west},${north},${east});
  way["leisure"~"^(park|garden|pitch)$"](${south},${west},${north},${east});
);
out geom;`;

  const url =
    'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(ql);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Overpass HTTP ${resp.status}`);
  }
  const json = await resp.json();
  return json.elements || [];
}

// Road width by highway type (metres)
const ROAD_WIDTHS = {
  motorway: 14,
  trunk: 14,
  primary: 12,
  secondary: 10,
  tertiary: 9,
  unclassified: 7,
  residential: 7,
  service: 5,
  living_street: 6,
  footway: 2,
  pedestrian: 4,
  path: 1.5,
  cycleway: 2.5,
  track: 4
};

// Building height in metres from OSM tags, with sensible fallback.
function osmBuildingHeight(tags) {
  if (tags.height) {
    const h = parseFloat(tags.height);
    if (!isNaN(h)) {
      return h;
    }
  }
  if (tags['building:levels']) {
    const levels = parseFloat(tags['building:levels']);
    if (!isNaN(levels)) {
      return levels * 3.2;
    }
  }
  return 8;
}

// Slight color variation per building so the city doesn't look like one giant block.
function osmBuildingColor(tags) {
  // Deterministic colour so the same building always renders the same shade
  const key =
    (tags.name || tags['addr:housenumber'] || '') + (tags.building || '');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const palette = [
    '#c8b89c',
    '#b8a888',
    '#a89878',
    '#d0c0a0',
    '#9c8c70',
    '#b09870',
    '#a89060'
  ];
  return palette[Math.abs(hash) % palette.length];
}

// Build a Three.js mesh for an extruded building polygon (vertices in local x,z).
function osmBuildingMesh(polygonPts, height, color) {
  if (polygonPts.length < 3) {
    return null;
  }
  const shape = new THREE.Shape();
  shape.moveTo(polygonPts[0].x, -polygonPts[0].z);
  for (let i = 1; i < polygonPts.length; i++) {
    shape.lineTo(polygonPts[i].x, -polygonPts[i].z);
  }
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false
  });
  geom.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: 0.05
  });
  return new THREE.Mesh(geom, mat);
}

// Build a single buffer-geometry mesh containing strips for every road
// segment in `ways`. ways = [{ points: [{x,z}], width: n, color: '#hex' }, ...]
function osmRoadsMesh(ways, color = '#3a3a3a', y = 0.05) {
  const positions = [];
  const indices = [];
  let off = 0;

  ways.forEach(({ points, width }) => {
    if (!points || points.length < 2) {
      return;
    }
    const w = width / 2;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.01) {
        continue;
      }
      const px = (-dz / len) * w;
      const pz = (dx / len) * w;
      positions.push(
        a.x - px,
        y,
        a.z - pz,
        a.x + px,
        y,
        a.z + pz,
        b.x + px,
        y,
        b.z + pz,
        b.x - px,
        y,
        b.z - pz
      );
      indices.push(off, off + 1, off + 2, off, off + 2, off + 3);
      off += 4;
    }
  });

  if (positions.length === 0) {
    return null;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.95 });
  return new THREE.Mesh(geom, mat);
}

// Compute a parallel offset path (used for sidewalks alongside roads).
// `offset` is signed perpendicular distance — positive = "left" of direction.
function offsetPath(points, offset) {
  if (!Array.isArray(points) || points.length < 2) {
    return points;
  }
  const result = [];
  for (let i = 0; i < points.length; i++) {
    let perpX = 0;
    let perpZ = 0;
    if (i === 0) {
      const dx = points[1].x - points[0].x;
      const dz = points[1].z - points[0].z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      perpX = -dz / len;
      perpZ = dx / len;
    } else if (i === points.length - 1) {
      const dx = points[i].x - points[i - 1].x;
      const dz = points[i].z - points[i - 1].z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      perpX = -dz / len;
      perpZ = dx / len;
    } else {
      // Average the incoming and outgoing perpendiculars to round corners
      const dx1 = points[i].x - points[i - 1].x;
      const dz1 = points[i].z - points[i - 1].z;
      const len1 = Math.sqrt(dx1 * dx1 + dz1 * dz1) || 1;
      const dx2 = points[i + 1].x - points[i].x;
      const dz2 = points[i + 1].z - points[i].z;
      const len2 = Math.sqrt(dx2 * dx2 + dz2 * dz2) || 1;
      perpX = -dz1 / len1 + -dz2 / len2;
      perpZ = dx1 / len1 + dx2 / len2;
      const pLen = Math.sqrt(perpX * perpX + perpZ * perpZ) || 1;
      perpX /= pLen;
      perpZ /= pLen;
    }
    result.push({
      x: points[i].x + perpX * offset,
      z: points[i].z + perpZ * offset
    });
  }
  return result;
}

// Build a flat polygonal slab (water, grass, parks).
function osmFlatPolyMesh(polygonPts, color, y = 0.02) {
  if (polygonPts.length < 3) {
    return null;
  }
  const shape = new THREE.Shape();
  shape.moveTo(polygonPts[0].x, -polygonPts[0].z);
  for (let i = 1; i < polygonPts.length; i++) {
    shape.lineTo(polygonPts[i].x, -polygonPts[i].z);
  }
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.95 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = y;
  return mesh;
}

async function buildGraphFromOSM(centerLat, centerLon, radiusMeters) {
  const ways = await fetchOSMRoads(centerLat, centerLon, radiusMeters);

  const nodes = {};
  const adj = {};
  const lanes = [];
  let nodeIdx = 0;
  const STEP = 5; // resample to one waypoint every 5 m
  const PROX = 4; // bridge graph nodes within this distance (intersections)

  ways.forEach((way) => {
    const highway = way.tags && way.tags.highway;
    if (!highway) {
      return;
    }
    const geom = way.geometry || [];
    if (geom.length < 2) {
      return;
    }

    // Convert + resample the way into uniform-spaced points
    const localPts = geom.map((g) =>
      gpsToLocal(g.lat, g.lon, centerLat, centerLon)
    );
    const resampled = [localPts[0]];
    for (let i = 1; i < localPts.length; i++) {
      const a = resampled[resampled.length - 1];
      const b = localPts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      const steps = Math.max(1, Math.floor(segLen / STEP));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        resampled.push({ x: a.x + dx * t, z: a.z + dz * t });
      }
    }

    if (OSM_DRIVABLE.has(highway)) {
      lanes.push(resampled);
    }
    if (OSM_WALKABLE.has(highway)) {
      let prevId = null;
      resampled.forEach((p) => {
        const id = `o${nodeIdx++}`;
        nodes[id] = p;
        adj[id] = [];
        if (prevId) {
          adj[prevId].push(id);
          adj[id].push(prevId);
        }
        prevId = id;
      });
    }
  });

  // Bridge graph nodes that are spatially close but came from different ways
  // (intersections in the OSM data).
  const ids = Object.keys(nodes);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = nodes[ids[i]];
      const b = nodes[ids[j]];
      const d = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
      if (d > 0.1 && d < PROX && !adj[ids[i]].includes(ids[j])) {
        adj[ids[i]].push(ids[j]);
        adj[ids[j]].push(ids[i]);
      }
    }
  }

  return { nodes, adj, lanes };
}

// ── Police patrol routes (waypoints in order, looping) ─────────────────────
// All waypoints sit on the correct driving lane (right-hand drive convention).
const POLICE_ROUTES = [
  // Route 1 — E-W shuttle: east on south lane, U-turn, west on north lane
  [
    { x: -25, z: LANE_OFFSET },
    { x: 25, z: LANE_OFFSET },
    { x: 25, z: -LANE_OFFSET },
    { x: -25, z: -LANE_OFFSET }
  ],
  // Route 2 — N-S shuttle: south on west lane, U-turn, north on east lane
  [
    { x: -LANE_OFFSET, z: -25 },
    { x: -LANE_OFFSET, z: 25 },
    { x: LANE_OFFSET, z: 25 },
    { x: LANE_OFFSET, z: -25 }
  ],
  // Route 3 — Mixed loop using both roads
  [
    { x: -20, z: LANE_OFFSET },
    { x: -LANE_OFFSET, z: LANE_OFFSET },
    { x: -LANE_OFFSET, z: 20 },
    { x: LANE_OFFSET, z: 20 },
    { x: LANE_OFFSET, z: LANE_OFFSET },
    { x: 20, z: LANE_OFFSET },
    { x: 20, z: -LANE_OFFSET },
    { x: -20, z: -LANE_OFFSET }
  ],
  // Route 4 — Smaller inner loop around the intersection
  [
    { x: 10, z: LANE_OFFSET },
    { x: 10, z: -LANE_OFFSET },
    { x: -10, z: -LANE_OFFSET },
    { x: -10, z: LANE_OFFSET }
  ]
];

// ════════════════════════════════════════════════════════════════════════════
// citizen-agent — walks the sidewalk graph
// ════════════════════════════════════════════════════════════════════════════
AFRAME.registerComponent('citizen-agent', {
  schema: {
    speed: { type: 'number', default: 1.5 },
    crimeRate: { type: 'number', default: 0.003 }
  },

  init() {
    this.state = CS.WANDERING;
    this.crimeTimer = 0;
    this.simComp = null;
    // Lazy-initialise on first tick: simComp (and therefore the active graph)
    // is set asynchronously by the orchestrator after componentinitialized.
    this.currentNode = null;
    this.targetNode = null;
  },

  _graph() {
    return (this.simComp && this.simComp.graph) || GRAPH;
  },

  _pickNext(currentId, previousId) {
    const adj = this._graph().adj[currentId] || [];
    const choices = adj.filter((n) => n !== previousId);
    if (choices.length === 0) {
      return previousId;
    }
    return choices[Math.floor(Math.random() * choices.length)];
  },

  _lazyInit() {
    const graph = this._graph();
    const ids = Object.keys(graph.nodes);
    if (ids.length === 0) {
      return false;
    }
    this.currentNode = ids[Math.floor(Math.random() * ids.length)];
    const n = graph.nodes[this.currentNode];
    this.el.object3D.position.set(n.x, 0, n.z);
    this.targetNode = this._pickNext(this.currentNode, null);
    return true;
  },

  tick(t, delta) {
    if (this.state === CS.DEAD || this.state === CS.ARRESTED) {
      return;
    }

    if (this.currentNode === null) {
      if (!this._lazyInit()) {
        return;
      }
    }

    const dt = delta / 1000;
    const pos = this.el.object3D.position;

    // Crime probability check (once per second while wandering)
    if (this.state === CS.WANDERING) {
      this.crimeTimer += dt;
      if (this.crimeTimer >= 1) {
        this.crimeTimer = 0;
        if (this.simComp && Math.random() < this.data.crimeRate) {
          this.simComp.attemptCrime(this);
          return;
        }
      }
    }

    // Move toward target node (in the active graph — detected or fallback)
    const target = this._graph().nodes[this.targetNode];
    if (!target) {
      return;
    }

    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);

    const spd =
      this.state === CS.FLEEING ? this.data.speed * 2.6 : this.data.speed;

    if (d < 0.4) {
      const next = this._pickNext(this.targetNode, this.currentNode);
      this.currentNode = this.targetNode;
      this.targetNode = next;
    } else {
      pos.x += (dx / d) * spd * dt;
      pos.z += (dz / d) * spd * dt;
      this.el.object3D.rotation.y = Math.atan2(dx, dz);
    }
  },

  flee() {
    this.state = CS.FLEEING;
    // Pick a far-away node in the active graph to flee toward
    const here = this.el.object3D.position;
    const graph = this._graph();
    const ids = Object.keys(graph.nodes);
    if (ids.length === 0) {
      return;
    }
    let farthest = ids[0];
    let farDist = 0;
    ids.forEach((id) => {
      const d = dist2D(graph.nodes[id], here);
      if (d > farDist) {
        farDist = d;
        farthest = id;
      }
    });
    this.targetNode = farthest;
  },

  die() {
    this.state = CS.DEAD;
    this.el.setAttribute('visible', false);
  },

  arrest() {
    if (this.state !== CS.FLEEING) {
      return false;
    }
    this.state = CS.ARRESTED;
    this.el.setAttribute('visible', false);
    return true;
  }
});

// ════════════════════════════════════════════════════════════════════════════
// police-agent — drives a road waypoint loop, deviates for crime response
// ════════════════════════════════════════════════════════════════════════════
AFRAME.registerComponent('police-agent', {
  schema: {
    speed: { type: 'number', default: 8 },
    routeIndex: { type: 'int', default: 0 }
  },

  init() {
    this.state = PS.PATROLLING;
    this.crimeScene = null;
    this.atSceneTimer = 0;
    this.sirenTimer = 0;
    this.sirenPhase = false;
    this.simComp = null;
    // Route + spawn position resolved lazily on first tick — the orchestrator
    // sets simComp.routes from scene detection (or fallback) after this init.
    this.route = null;
    this.waypointIdx = 0;

    // Siren light (alternates blue/red when responding)
    const siren = document.createElement('a-light');
    siren.setAttribute('type', 'point');
    siren.setAttribute('color', '#0044ff');
    siren.setAttribute('intensity', '0');
    siren.setAttribute('distance', '14');
    siren.setAttribute('decay', '2');
    siren.setAttribute('position', '0 1.5 0');
    this.el.appendChild(siren);
    this.sirenEl = siren;

    // Apply blue tint to the vehicle mesh once loaded
    this.el.addEventListener('model-loaded', () => {
      this.el.object3D.traverse((child) => {
        if (!child.isMesh) {
          return;
        }
        const mats = Array.isArray(child.material)
          ? child.material
          : [child.material];
        mats.forEach((m) => {
          if (m && m.color) {
            m.color.set('#1144ee');
            m.needsUpdate = true;
          }
        });
      });
    });
  },

  respondTo(scene, dropOffOverride) {
    this.state = PS.RESPONDING;
    this.crimeScene = scene;
    // The dispatcher passes the closest point on THIS car's route to the
    // crime — drive there and stop. No off-road approach (police stays on
    // the road network at all times).
    this.dropOffPoint =
      dropOffOverride ||
      (this.simComp && this.simComp.nearestRoadApproachPoint
        ? this.simComp.nearestRoadApproachPoint(scene)
        : fallbackRoadApproachPoint(scene));
    this.sirenEl.setAttribute('intensity', '4');
  },

  _lazyInitRoute() {
    if (
      !this.simComp ||
      !this.simComp.routes ||
      this.simComp.routes.length === 0
    ) {
      return false;
    }
    const idx = this.data.routeIndex % this.simComp.routes.length;
    this.route = this.simComp.routes[idx];
    if (this.route && this.route.length > 0) {
      const wp = this.route[0];
      this.el.object3D.position.set(wp.x, 0, wp.z);
    }
    return true;
  },

  tick(t, delta) {
    const dt = delta / 1000;
    const pos = this.el.object3D.position;

    if (this.route === null) {
      if (!this._lazyInitRoute()) {
        return;
      }
    }

    // Siren flash
    const sirenActive =
      this.state === PS.RESPONDING || this.state === PS.AT_SCENE;
    if (sirenActive) {
      this.sirenTimer += dt;
      if (this.sirenTimer > 0.22) {
        this.sirenTimer = 0;
        this.sirenPhase = !this.sirenPhase;
        this.sirenEl.setAttribute(
          'color',
          this.sirenPhase ? '#0044ff' : '#ff2200'
        );
      }
    }

    // Wait at crime scene, then resume patrol
    if (this.state === PS.AT_SCENE) {
      this.atSceneTimer += dt;
      if (this.atSceneTimer > 4) {
        this.state = PS.PATROLLING;
        this.crimeScene = null;
        this.atSceneTimer = 0;
        this.sirenEl.setAttribute('intensity', '0');
      }
      return;
    }

    // Pick movement target.
    // When responding: drive on the road to the closest route waypoint to the
    // crime (the drop-off point chosen by the dispatcher). NEVER leave the
    // road. Once arrived, attempt to detect/arrest from there.
    let target = null;
    let spd = this.data.speed;
    if (this.state === PS.PATROLLING) {
      target = this.route[this.waypointIdx] || null;
    } else if (this.state === PS.RESPONDING) {
      target = this.dropOffPoint;
      spd = this.data.speed * 1.8; // sirens blaring, fast pursuit
    }

    if (!target) {
      return;
    }

    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);

    if (d < 1.5) {
      if (this.state === PS.PATROLLING) {
        this.waypointIdx = (this.waypointIdx + 1) % this.route.length;
      } else if (this.state === PS.RESPONDING) {
        // Arrived at the closest accessible road point — try to detect/arrest
        this.state = PS.AT_SCENE;
        this.atSceneTimer = 0;
        this.sirenEl.setAttribute('intensity', '1.5');
        if (this.simComp) {
          this.simComp.tryArrest(pos);
        }
      }
    } else {
      pos.x += (dx / d) * spd * dt;
      pos.z += (dz / d) * spd * dt;
      this.el.object3D.rotation.y = Math.atan2(dx, dz);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// city-simulation — master orchestrator
// ════════════════════════════════════════════════════════════════════════════
AFRAME.registerComponent('city-simulation', {
  schema: {
    citizenCount: { type: 'int', default: 15 },
    policeCount: { type: 'int', default: 3 },
    crimeRate: { type: 'number', default: 0.003 },
    citizenSpeed: { type: 'number', default: 1.5 },
    policeSpeed: { type: 'number', default: 8 },
    paused: { type: 'boolean', default: false },
    spawnCity: { type: 'boolean', default: true },
    // When false, init() does NOT auto-spawn agents. Used by the React
    // panel's "OSM city" mode so it can call buildOSMCity() manually
    // without racing against the auto-spawn (which would result in 2× cars).
    autoSpawn: { type: 'boolean', default: true }
  },

  init() {
    this.citizens = [];
    this.police = [];
    this.pendingCrimes = [];
    this.stats = {
      total: 0,
      resolved: 0,
      avgResponseMs: 0,
      _rtAcc: 0,
      _rtCount: 0
    };
    // Active sidewalk graph + police routes — populated by _spawn().
    this.graph = GRAPH;
    this.routes = POLICE_ROUTES;
    this.detectedFromScene = false;

    this._CHAR_MIXINS = [
      'a_char1',
      'a_char2',
      'a_char3',
      'a_char4',
      'a_char5',
      'a_char6',
      'a_char7',
      'a_char8'
    ];

    if (!this.data.autoSpawn) {
      // Manual mode (e.g. OSM city): caller will invoke buildOSMCity()
      // explicitly. Don't trigger the default _spawn() flow here, otherwise
      // we'd spawn agents twice.
      return;
    }
    if (this.el.sceneEl.hasLoaded) {
      this._spawn();
    } else {
      this.el.sceneEl.addEventListener('loaded', () => this._spawn());
    }
  },

  async _spawn() {
    // 1) If the scene is geo-anchored (has <street-geo>), fetch the real OSM
    //    road network for that area and use it as the simulation's graph.
    const geoEl = document.querySelector('[street-geo]');
    if (geoEl && geoEl.components && geoEl.components['street-geo']) {
      const gd = geoEl.components['street-geo'].data;
      if (gd && gd.latitude && gd.longitude) {
        // eslint-disable-next-line no-console
        console.log(
          `[city-sim] geo scene detected (${gd.latitude.toFixed(5)}, ${gd.longitude.toFixed(5)}) — fetching OSM…`
        );
        try {
          const osm = await buildGraphFromOSM(gd.latitude, gd.longitude, 250);
          if (Object.keys(osm.nodes).length > 0 || osm.lanes.length > 0) {
            if (Object.keys(osm.nodes).length > 0) {
              this.graph = osm;
            }
            if (osm.lanes.length > 0) {
              this.routes = osm.lanes.map(laneToRoute);
            }
            this.detectedFromScene = true;
            // eslint-disable-next-line no-console
            console.log(
              `[city-sim] using OSM streets: ${Object.keys(this.graph.nodes).length} walkable nodes, ${this.routes.length} drive lanes`
            );
            this._spawnAgents();
            this._broadcast();
            return;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[city-sim] OSM fetch failed:', err.message || err);
        }
      }
    }

    // 2) Otherwise, try to detect 3DStreet street-segments already in the scene.
    const detected = this._detectFromScene();
    if (
      detected &&
      (Object.keys(detected.nodes).length > 0 || detected.lanes.length > 0)
    ) {
      if (Object.keys(detected.nodes).length > 0) {
        this.graph = detected;
      }
      if (detected.lanes.length > 0) {
        this.routes = detected.lanes.map(laneToRoute);
      }
      this.detectedFromScene = true;
      // eslint-disable-next-line no-console
      console.log(
        `[city-sim] using scene streets: ${Object.keys(this.graph.nodes).length} sidewalk nodes, ${this.routes.length} police routes`
      );
    } else if (this.data.spawnCity) {
      // 3) Nothing — fall back to spawning the default hardcoded intersection.
      this._spawnCity();
      // eslint-disable-next-line no-console
      console.log('[city-sim] no streets in scene — spawned default city');
    }
    this._spawnAgents();
    this._broadcast();
  },

  // ── Scene detection ─────────────────────────────────────────────────────
  // Scan all <a-entity street-segment> in the scene. For each sidewalk-like
  // segment, generate walking nodes along its centerline. For each drive-lane
  // segment, generate a lane of car waypoints. Connect sidewalk nodes from
  // different segments by spatial proximity (intersections "just work").
  _detectFromScene() {
    const SIDEWALK_TYPES = new Set([
      'sidewalk',
      'sidewalk-tree',
      'sidewalk-bench',
      'sidewalk-lamp',
      'sidewalk-bike-rack',
      'sidewalk-wayfinding',
      'parking-lane'
    ]);
    const DRIVE_TYPES = new Set([
      'drive-lane',
      'turn-lane',
      'bus-lane',
      'bike-lane',
      'scooter'
    ]);
    const STEP = 4; // waypoints every 4 metres along a segment
    const PROX = 3.5; // connect sidewalk nodes within this distance (intersections)

    const segs = Array.from(
      document.querySelectorAll('[street-segment]')
    ).filter((el) => !el.classList.contains(SPAWN_CLASS));
    if (segs.length === 0) {
      return null;
    }

    const nodes = {};
    const adj = {};
    const lanes = [];
    let nodeIdx = 0;

    segs.forEach((el) => {
      const seg = el.components && el.components['street-segment'];
      if (!seg) {
        return;
      }
      const type = seg.data && seg.data.type;
      const isSidewalk = SIDEWALK_TYPES.has(type);
      const isDrive = DRIVE_TYPES.has(type);
      if (!isSidewalk && !isDrive) {
        return;
      }

      const length = (seg.data && seg.data.length) || 60;
      const numNodes = Math.max(2, Math.floor(length / STEP) + 1);

      // Walk along the segment's local Z axis, converting each sample to world coords.
      el.object3D.updateMatrixWorld(true);
      const points = [];
      for (let i = 0; i < numNodes; i++) {
        const t = (i / (numNodes - 1) - 0.5) * length;
        const v = new THREE.Vector3(0, 0, t);
        el.object3D.localToWorld(v);
        points.push({ x: v.x, z: v.z });
      }

      if (isSidewalk) {
        let prevId = null;
        points.forEach((p) => {
          const id = `n${nodeIdx++}`;
          nodes[id] = p;
          adj[id] = [];
          if (prevId) {
            adj[prevId].push(id);
            adj[id].push(prevId);
          }
          prevId = id;
        });
      } else if (isDrive && points.length >= 2) {
        lanes.push(points);
      }
    });

    // Bridge sidewalk segments at intersections via proximity.
    const ids = Object.keys(nodes);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = nodes[ids[i]];
        const b = nodes[ids[j]];
        const d = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
        if (d > 0.1 && d < PROX && !adj[ids[i]].includes(ids[j])) {
          adj[ids[i]].push(ids[j]);
          adj[ids[j]].push(ids[i]);
        }
      }
    }

    return { nodes, adj, lanes };
  },

  // ── Build a stylised "SimCity"-style rendering of a real area from OSM
  // data. Generates buildings, roads and water/grass polygons all from the
  // same OSM source so the simulation graph matches the visible geometry
  // perfectly (no Google-Tiles vs OSM offset). Called from the React panel.
  async buildOSMCity(centerLat, centerLon, radiusMeters = 400) {
    const scene = this.el.sceneEl;

    // Versioning: if the user clicks a city button while a previous build is
    // still fetching, cancel the older build so it doesn't spawn ghost agents
    // on top of the new ones.
    this._buildVersion = (this._buildVersion || 0) + 1;
    const myVersion = this._buildVersion;

    // Per-build marker color → user can instantly tell which build a car
    // belongs to. White marker = current build, any other colour = zombie.
    const BUILD_COLORS = [
      '#ffffff',
      '#ffaa00',
      '#00ffff',
      '#ff00ff',
      '#88ff00'
    ];
    this.currentBuildColor =
      BUILD_COLORS[(myVersion - 1) % BUILD_COLORS.length];

    // Wipe any prior spawn (city + agents + VFX) — pause components first to
    // stop their tick callbacks immediately, then remove from the DOM.
    let cleanedSpawned = 0;
    document.querySelectorAll('.' + SPAWN_CLASS).forEach((el) => {
      if (el.components) {
        Object.keys(el.components).forEach((name) => {
          const c = el.components[name];
          if (c && typeof c.pause === 'function') {
            c.pause();
          }
        });
      }
      if (el.parentNode) {
        el.parentNode.removeChild(el);
        cleanedSpawned++;
      }
    });

    // Zombie hunter: any [police-agent] / [citizen-agent] that survived
    // (e.g. spawned by an earlier session before SPAWN_CLASS existed) gets
    // force-removed here so they can't keep wandering.
    let cleanedZombies = 0;
    ['police-agent', 'citizen-agent'].forEach((c) => {
      document.querySelectorAll(`[${c}]`).forEach((el) => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
          cleanedZombies++;
        }
      });
    });
    if (cleanedSpawned > 0 || cleanedZombies > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[city-sim] cleanup: ${cleanedSpawned} tagged + ${cleanedZombies} zombies removed`
      );
    }

    this.citizens = [];
    this.police = [];
    this.pendingCrimes = [];

    // Sky + ground + lights so the scene isn't black if there's no other env.
    const tag = (el) => {
      el.classList.add(SPAWN_CLASS);
      return el;
    };
    if (!scene.querySelector('a-sky')) {
      const sky = document.createElement('a-sky');
      sky.setAttribute('color', '#9fb8d4');
      sky.setAttribute('radius', 800);
      scene.appendChild(tag(sky));
    }
    const ambient = document.createElement('a-light');
    ambient.setAttribute('type', 'ambient');
    ambient.setAttribute('color', '#b0c8e8');
    ambient.setAttribute('intensity', 0.6);
    scene.appendChild(tag(ambient));
    const sun = document.createElement('a-light');
    sun.setAttribute('type', 'directional');
    sun.setAttribute('color', '#fff6e0');
    sun.setAttribute('intensity', 1.5);
    sun.setAttribute('position', '50 100 -30');
    scene.appendChild(tag(sun));

    // Big green ground plane covering the whole area.
    const ground = document.createElement('a-plane');
    ground.setAttribute('rotation', '-90 0 0');
    ground.setAttribute('width', radiusMeters * 2.5);
    ground.setAttribute('height', radiusMeters * 2.5);
    ground.setAttribute('color', '#4d7a4d');
    ground.setAttribute('position', '0 0 0');
    scene.appendChild(tag(ground));

    // Fetch OSM in one query
    let elements;
    try {
      elements = await fetchOSMCity(centerLat, centerLon, radiusMeters);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[city-sim] OSM fetch failed:', err);
      window.dispatchEvent(
        new CustomEvent('city-osm-status', {
          detail: { phase: 'error', message: err.message || String(err) }
        })
      );
      return;
    }

    // Abort if a newer build started while we were waiting on the network
    if (this._buildVersion !== myVersion) {
      return;
    }

    // ── Categorise + project to local coords ────────────────────────────────
    const roads = []; // { points, width, highway }
    const buildings = []; // { points, height, color }
    const water = []; // points[]
    const greens = []; // points[]
    const STEP = 5;

    elements.forEach((el) => {
      if (el.type !== 'way' || !el.geometry) {
        return;
      }
      const localPts = el.geometry.map((g) =>
        gpsToLocal(g.lat, g.lon, centerLat, centerLon)
      );
      const tags = el.tags || {};

      if (tags.highway) {
        // Resample for smoother strips
        const resampled = [localPts[0]];
        for (let i = 1; i < localPts.length; i++) {
          const a = resampled[resampled.length - 1];
          const b = localPts[i];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const segLen = Math.sqrt(dx * dx + dz * dz);
          const steps = Math.max(1, Math.floor(segLen / STEP));
          for (let k = 1; k <= steps; k++) {
            const t = k / steps;
            resampled.push({ x: a.x + dx * t, z: a.z + dz * t });
          }
        }
        const width = ROAD_WIDTHS[tags.highway] || 6;
        roads.push({ points: resampled, width, highway: tags.highway });
      } else if (tags.building) {
        buildings.push({
          points: localPts,
          height: osmBuildingHeight(tags),
          color: osmBuildingColor(tags)
        });
      } else if (tags.natural === 'water' || tags.waterway) {
        water.push(localPts);
      } else if (
        tags.landuse === 'grass' ||
        tags.landuse === 'forest' ||
        tags.landuse === 'meadow' ||
        tags.landuse === 'recreation_ground' ||
        tags.landuse === 'cemetery' ||
        tags.leisure === 'park' ||
        tags.leisure === 'garden' ||
        tags.leisure === 'pitch'
      ) {
        greens.push(localPts);
      }
    });

    // ── Render water + green areas (under roads) ────────────────────────────
    greens.forEach((pts) => {
      const m = osmFlatPolyMesh(pts, '#5d8a4d', 0.02);
      if (!m) {
        return;
      }
      const wrap = document.createElement('a-entity');
      wrap.setObject3D('mesh', m);
      scene.appendChild(tag(wrap));
    });
    water.forEach((pts) => {
      const m = osmFlatPolyMesh(pts, '#3a6a8a', 0.04);
      if (!m) {
        return;
      }
      const wrap = document.createElement('a-entity');
      wrap.setObject3D('mesh', m);
      scene.appendChild(tag(wrap));
    });

    // ── Render roads (one merged mesh) ──────────────────────────────────────
    const roadMesh = osmRoadsMesh(roads, '#383838', 0.08);
    if (roadMesh) {
      const wrap = document.createElement('a-entity');
      wrap.setObject3D('mesh', roadMesh);
      scene.appendChild(tag(wrap));
    }
    // Sidewalks: same network rendered slightly wider, lighter, just below
    const sidewalkMesh = osmRoadsMesh(
      roads.map((r) => ({ ...r, width: r.width + 3 })),
      '#9a9a92',
      0.06
    );
    if (sidewalkMesh) {
      const wrap = document.createElement('a-entity');
      wrap.setObject3D('mesh', sidewalkMesh);
      scene.appendChild(tag(wrap));
    }

    // ── Render buildings (one mesh per polygon) ─────────────────────────────
    buildings.forEach(({ points, height, color }) => {
      const m = osmBuildingMesh(points, height, color);
      if (!m) {
        return;
      }
      const wrap = document.createElement('a-entity');
      wrap.setObject3D('mesh', m);
      wrap.setAttribute('shadow', 'cast: true; receive: true');
      scene.appendChild(tag(wrap));
    });

    // ── Build the simulation graph from the SAME road data ──────────────────
    // Cars: drive on the road centerline (lanes).
    // Citizens: walk on parallel sidewalk paths offset perpendicular to each
    // road by half the road width + 1.5 m. So agents render visibly OFF the
    // black asphalt and ON the lighter sidewalk strip we drew earlier.
    const nodes = {};
    const adj = {};
    const lanes = [];
    let nodeIdx = 0;
    const PROX = 4.5;

    function addPathToGraph(path) {
      let prevId = null;
      path.forEach((p) => {
        const id = `o${nodeIdx++}`;
        nodes[id] = p;
        adj[id] = [];
        if (prevId) {
          adj[prevId].push(id);
          adj[id].push(prevId);
        }
        prevId = id;
      });
    }

    roads.forEach(({ points, width, highway }) => {
      // Only true drivable roads — explicitly skip tracks/footways/cycleways
      // (police shouldn't patrol forest tracks or parking-lot alleys).
      const drivable = OSM_DRIVABLE.has(highway);
      const walkable = highway !== 'motorway' && highway !== 'trunk';

      if (drivable) {
        lanes.push(points);
      }
      if (walkable) {
        if (drivable) {
          // Real road → walk on both sidewalks, not in the middle of traffic
          const sidewalkOffset = width / 2 + 1.5;
          addPathToGraph(offsetPath(points, sidewalkOffset));
          addPathToGraph(offsetPath(points, -sidewalkOffset));
        } else {
          // Pedestrian-only path (footway, pedestrian, path, cycleway):
          // walk on its centerline directly
          addPathToGraph(points);
        }
      }
    });

    // Bridge intersections (and the two sides of each road at junctions)
    const ids = Object.keys(nodes);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = nodes[ids[i]];
        const b = nodes[ids[j]];
        const d = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
        if (d > 0.1 && d < PROX && !adj[ids[i]].includes(ids[j])) {
          adj[ids[i]].push(ids[j]);
          adj[ids[j]].push(ids[i]);
        }
      }
    }
    // Sort + filter lanes so police cars get assigned the most prominent
    // (longest, easiest to see) roads — not random 10 m alley fragments.
    const pathLength = (pts) => {
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x;
        const dz = pts[i + 1].z - pts[i].z;
        total += Math.sqrt(dx * dx + dz * dz);
      }
      return total;
    };
    const sortedLanes = lanes
      .filter((l) => pathLength(l) >= 80)
      .sort((a, b) => pathLength(b) - pathLength(a));

    this.graph = { nodes, adj };
    // Limit to a manageable number of routes so visualisation stays readable
    // and so every police car is guaranteed to land on a *marked* route.
    const MAX_ROUTES = Math.max(this.data.policeCount, 15);
    const usableLanes = sortedLanes.length > 0 ? sortedLanes : lanes;
    this.routes = usableLanes.slice(0, MAX_ROUTES).map(laneToRoute);
    this.detectedFromScene = true;

    // eslint-disable-next-line no-console
    console.log(
      `[city-sim] OSM city built: ${buildings.length} buildings, ${roads.length} roads, ${water.length} water polys, ${greens.length} green areas`
    );
    window.dispatchEvent(
      new CustomEvent('city-osm-status', {
        detail: {
          phase: 'done',
          buildings: buildings.length,
          roads: roads.length,
          water: water.length,
          greens: greens.length
        }
      })
    );

    // ── Spawn agents on the new graph ───────────────────────────────────────
    this._spawnAgents();
    this._debugVisualizeRoutes();
    this._broadcast();
  },

  // Debug: highlight the routes the police cars are actually patrolling.
  // Bright cyan dots follow the lane centerlines so we can see whether the
  // route data lines up with the visible black asphalt strip we drew.
  _debugVisualizeRoutes() {
    const scene = this.el.sceneEl;
    // Cache the palette as a class property so police cars can read the
    // matching colour for their assigned routeIndex.
    this.routeColors = ROUTE_COLOR_PALETTE;
    // Visualise EVERY police route so the user can match each car to its
    // patrol path and see which roads are covered.
    const numToShow = this.routes.length;
    for (let r = 0; r < numToShow; r++) {
      const route = this.routes[r];
      const color = ROUTE_COLOR_PALETTE[r % ROUTE_COLOR_PALETTE.length];
      route.forEach((wp, i) => {
        if (i % 2 !== 0) {
          return;
        } // sparse: every other waypoint
        const dot = document.createElement('a-sphere');
        dot.classList.add(SPAWN_CLASS);
        dot.setAttribute('radius', 0.5);
        dot.setAttribute('color', color);
        dot.setAttribute(
          'material',
          `emissive: ${color}; emissiveIntensity: 1`
        );
        dot.setAttribute('position', `${wp.x} 1.5 ${wp.z}`);
        scene.appendChild(dot);
      });
    }
  },

  // Drop-off point for police responding to a crime — projects the crime
  // onto the nearest detected drive-lane waypoint, or falls back to the
  // hardcoded city's lane axes when nothing was detected.
  nearestRoadApproachPoint(crime) {
    if (!this.detectedFromScene || !this.routes || this.routes.length === 0) {
      return fallbackRoadApproachPoint(crime);
    }
    let best = null;
    let bestD = Infinity;
    this.routes.forEach((route) => {
      route.forEach((wp) => {
        const d = (wp.x - crime.x) ** 2 + (wp.z - crime.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = wp;
        }
      });
    });
    return best || fallbackRoadApproachPoint(crime);
  },

  // ── Spawn the city infrastructure (roads, sidewalks, crosswalks, buildings)
  _spawnCity() {
    const scene = this.el.sceneEl;
    const tag = (el) => {
      el.classList.add(SPAWN_CLASS);
      return el;
    };
    const make = (tagName, attrs) => {
      const el = document.createElement(tagName);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      return tag(el);
    };

    // Ground (large grass plane)
    scene.appendChild(
      make('a-plane', {
        rotation: '-90 0 0',
        width: 200,
        height: 200,
        color: '#3f6d3f',
        position: '0 -0.01 0',
        shadow: 'receive: true'
      })
    );

    // N-S road (asphalt)
    scene.appendChild(
      make('a-plane', {
        rotation: '-90 0 0',
        width: 9,
        height: ROAD_LENGTH,
        position: '0 0 0',
        color: '#383838'
      })
    );
    // E-W road
    scene.appendChild(
      make('a-plane', {
        rotation: '-90 0 0',
        width: ROAD_LENGTH,
        height: 9,
        position: '0 0.001 0',
        color: '#383838'
      })
    );
    // Intersection square (slightly darker)
    scene.appendChild(
      make('a-plane', {
        rotation: '-90 0 0',
        width: 9,
        height: 9,
        position: '0 0.002 0',
        color: '#2c2c2c'
      })
    );

    // Yellow center dashed lines on N-S road
    for (let z = -28; z <= 28; z += 4) {
      if (Math.abs(z) < 5) {
        continue;
      } // skip intersection
      scene.appendChild(
        make('a-box', {
          width: 0.18,
          height: 0.005,
          depth: 1.6,
          position: `0 0.01 ${z}`,
          color: '#e8d030'
        })
      );
    }
    // Yellow center dashed lines on E-W road
    for (let x = -28; x <= 28; x += 4) {
      if (Math.abs(x) < 5) {
        continue;
      }
      scene.appendChild(
        make('a-box', {
          width: 1.6,
          height: 0.005,
          depth: 0.18,
          position: `${x} 0.01 0`,
          color: '#e8d030'
        })
      );
    }

    // 4 sidewalks (slightly raised)
    const swColor = '#b8b0a4';
    // West sidewalk (along x = -SIDEWALK_CENTER, length = ROAD_LENGTH)
    scene.appendChild(
      make('a-plane', {
        rotation: '-90 0 0',
        width: 2.5,
        height: ROAD_LENGTH,
        position: `${-SIDEWALK_CENTER} 0.015 0`,
        color: swColor
      })
    );
    scene.appendChild(
      make('a-plane', {
        rotation: '-90 0 0',
        width: 2.5,
        height: ROAD_LENGTH,
        position: `${SIDEWALK_CENTER} 0.015 0`,
        color: swColor
      })
    );
    scene.appendChild(
      make('a-plane', {
        rotation: '-90 0 0',
        width: ROAD_LENGTH,
        height: 2.5,
        position: `0 0.015 ${-SIDEWALK_CENTER}`,
        color: swColor
      })
    );
    scene.appendChild(
      make('a-plane', {
        rotation: '-90 0 0',
        width: ROAD_LENGTH,
        height: 2.5,
        position: `0 0.015 ${SIDEWALK_CENTER}`,
        color: swColor
      })
    );

    // Crosswalks (white stripes at the 4 sides of the intersection)
    const stripeCount = 7;
    for (let i = 0; i < stripeCount; i++) {
      const t = (i / (stripeCount - 1) - 0.5) * 7;
      // North & South crosswalks (across N-S road)
      scene.appendChild(
        make('a-box', {
          width: 0.6,
          height: 0.005,
          depth: 2.5,
          position: `${t} 0.012 ${-ROAD_HALF_WIDTH - 0.5}`,
          color: '#ffffff'
        })
      );
      scene.appendChild(
        make('a-box', {
          width: 0.6,
          height: 0.005,
          depth: 2.5,
          position: `${t} 0.012 ${ROAD_HALF_WIDTH + 0.5}`,
          color: '#ffffff'
        })
      );
      // East & West crosswalks (across E-W road)
      scene.appendChild(
        make('a-box', {
          width: 2.5,
          height: 0.005,
          depth: 0.6,
          position: `${-ROAD_HALF_WIDTH - 0.5} 0.012 ${t}`,
          color: '#ffffff'
        })
      );
      scene.appendChild(
        make('a-box', {
          width: 2.5,
          height: 0.005,
          depth: 0.6,
          position: `${ROAD_HALF_WIDTH + 0.5} 0.012 ${t}`,
          color: '#ffffff'
        })
      );
    }

    // Stop lines at intersection
    [-1, 1].forEach((s) => {
      scene.appendChild(
        make('a-box', {
          width: 4,
          height: 0.005,
          depth: 0.3,
          position: `${s * 2.25} 0.012 ${s * (ROAD_HALF_WIDTH - 0.3)}`,
          color: '#ffffff'
        })
      );
      scene.appendChild(
        make('a-box', {
          width: 0.3,
          height: 0.005,
          depth: 4,
          position: `${s * (ROAD_HALF_WIDTH - 0.3)} 0.012 ${s * -2.25}`,
          color: '#ffffff'
        })
      );
    });

    // ── Buildings on the 4 corners — using real 3DStreet GLB assets ──
    // Mixins are auto-injected by <street-assets>; rotation faces intersection.
    const buildings = [
      { mixin: 'SM_Bld_House_Preset_03_1800', x: -15, z: -15, ry: 135 },
      { mixin: 'sp-prop-mixeduse-3L-22ft', x: 15, z: -15, ry: -135 },
      { mixin: 'arched-building-02', x: -15, z: 15, ry: 45 },
      { mixin: 'sp-prop-mixeduse-2L-29ft', x: 15, z: 15, ry: -45 }
    ];
    buildings.forEach(({ mixin, x, z, ry }) => {
      const b = make('a-entity', {
        mixin,
        position: `${x} 0 ${z}`,
        rotation: `0 ${ry} 0`,
        shadow: 'cast: true; receive: true'
      });
      // Fallback colored box behind the GLB in case the mixin is missing
      const fallback = make('a-box', {
        width: 8,
        height: 6,
        depth: 8,
        position: `${x} 3 ${z}`,
        color: '#88776a',
        visible: false
      });
      b.addEventListener(
        'model-loaded',
        () => fallback.parentNode && fallback.parentNode.removeChild(fallback),
        { once: true }
      );
      // If model never loads after 4s, reveal the fallback
      setTimeout(() => {
        if (fallback.parentNode) {
          fallback.setAttribute('visible', true);
        }
      }, 4000);
      scene.appendChild(b);
      scene.appendChild(fallback);
    });

    // ── Trees lining the sidewalks — real 3DStreet tree assets ──
    const treeMixins = [
      'sp-tree-honeylocust-24ft',
      'sp-tree-buroak-24ft',
      'sp-tree-japaneselilac-20ft'
    ];
    const treeSpots = [];
    // 3 trees per arm, on the outer edge of each sidewalk
    [-22, -14, 14, 22].forEach((d) => {
      treeSpots.push({ x: -SIDEWALK_OUTER, z: d }); // West sidewalk outer edge
      treeSpots.push({ x: SIDEWALK_OUTER, z: d }); // East sidewalk outer edge
      treeSpots.push({ x: d, z: -SIDEWALK_OUTER }); // North sidewalk outer edge
      treeSpots.push({ x: d, z: SIDEWALK_OUTER }); // South sidewalk outer edge
    });
    treeSpots.forEach((spot, i) => {
      scene.appendChild(
        make('a-entity', {
          mixin: treeMixins[i % treeMixins.length],
          position: `${spot.x} 0 ${spot.z}`,
          rotation: `0 ${(i * 47) % 360} 0`
        })
      );
    });

    // ── Street lamps at the 4 intersection corners ──
    [
      [-7, -7],
      [7, -7],
      [-7, 7],
      [7, 7]
    ].forEach(([x, z]) => {
      scene.appendChild(
        make('a-entity', {
          mixin: 'lamp-modern',
          position: `${x} 0 ${z}`
        })
      );
    });

    // ── Benches on the inner sidewalk near the intersection ──
    [
      { x: -SIDEWALK_CENTER + 0.3, z: -10, ry: 90 },
      { x: SIDEWALK_CENTER - 0.3, z: 10, ry: -90 },
      { x: -10, z: -SIDEWALK_CENTER + 0.3, ry: 180 },
      { x: 10, z: SIDEWALK_CENTER - 0.3, ry: 0 }
    ].forEach(({ x, z, ry }) => {
      scene.appendChild(
        make('a-entity', {
          mixin: 'bench',
          position: `${x} 0 ${z}`,
          rotation: `0 ${ry} 0`
        })
      );
    });

    // Sky + lighting (only if scene has none of its own)
    if (!scene.querySelector('a-sky')) {
      scene.appendChild(make('a-sky', { color: '#9fb8d4', radius: 400 }));
    }
    scene.appendChild(
      make('a-light', {
        type: 'ambient',
        color: '#b0c8e8',
        intensity: 0.55
      })
    );
    scene.appendChild(
      make('a-light', {
        type: 'directional',
        color: '#fff6e0',
        intensity: 1.8,
        position: '15 30 -10',
        'cast-shadow': 'true'
      })
    );
  },

  _spawnAgents() {
    const scene = this.el.sceneEl;
    // Geo / OSM-city mode: agents are spread across hundreds of metres and
    // viewed from a high camera. Keep them at default scale (the user wants
    // realistic proportions) but add a slim coloured pillar over each one
    // so they remain pickable from any altitude.
    const isGeo =
      this.detectedFromScene &&
      Object.keys(this.graph.nodes)[0] &&
      Object.keys(this.graph.nodes)[0].startsWith('o');

    // Citizens — random spawn nodes on the active graph
    for (let i = 0; i < this.data.citizenCount; i++) {
      const el = document.createElement('a-entity');
      el.classList.add(SPAWN_CLASS);
      el.setAttribute('mixin', this._CHAR_MIXINS[i % this._CHAR_MIXINS.length]);
      el.setAttribute('scale', '1 1 1');
      el.setAttribute('citizen-agent', {
        speed: this.data.citizenSpeed + rand(-0.3, 0.3),
        crimeRate: this.data.crimeRate
      });

      if (isGeo) {
        const pillar = document.createElement('a-cylinder');
        pillar.setAttribute('radius', 0.25);
        pillar.setAttribute('height', 8);
        pillar.setAttribute('color', '#22dd44');
        pillar.setAttribute(
          'material',
          'emissive: #22dd44; emissiveIntensity: 0.7'
        );
        pillar.setAttribute('position', '0 5 0');
        el.appendChild(pillar);
      }

      scene.appendChild(el);

      el.addEventListener('componentinitialized', (e) => {
        if (e.detail.name !== 'citizen-agent') {
          return;
        }
        // If the entity was removed during async init, don't track it
        if (!el.parentNode) {
          return;
        }
        const comp = el.components['citizen-agent'];
        comp.simComp = this;
        this.citizens.push(comp);
      });
    }

    // Police cars — one per route
    for (let i = 0; i < this.data.policeCount; i++) {
      const el = document.createElement('a-entity');
      el.classList.add(SPAWN_CLASS);
      el.setAttribute('mixin', 'sedan-rig');
      el.setAttribute('scale', '1 1 1');
      el.setAttribute('police-agent', {
        speed: this.data.policeSpeed,
        routeIndex: i % Math.max(1, this.routes.length)
      });

      if (isGeo) {
        // Pillar colour matches this car's assigned route colour, so you can
        // visually pair a car to its line of bright dots on the ground.
        const routeIdx = i % Math.max(1, this.routes.length);
        const routeColor =
          ROUTE_COLOR_PALETTE[routeIdx % ROUTE_COLOR_PALETTE.length];

        const pillar = document.createElement('a-cylinder');
        pillar.setAttribute('radius', 0.35);
        pillar.setAttribute('height', 12);
        pillar.setAttribute('color', routeColor);
        pillar.setAttribute(
          'material',
          `emissive: ${routeColor}; emissiveIntensity: 0.9`
        );
        pillar.setAttribute('position', '0 7 0');
        el.appendChild(pillar);

        // Build-coloured ground marker — sphere at the entity's exact origin.
        // The colour is unique per buildOSMCity() invocation, so any car
        // whose marker doesn't match the expected current-build colour is a
        // zombie left over from a previous build.
        const buildColor = this.currentBuildColor || '#ffffff';
        const marker = document.createElement('a-sphere');
        marker.setAttribute('radius', 0.6);
        marker.setAttribute('color', buildColor);
        marker.setAttribute(
          'material',
          `emissive: ${buildColor}; emissiveIntensity: 1`
        );
        marker.setAttribute('position', '0 0.7 0');
        el.appendChild(marker);
      }

      scene.appendChild(el);

      el.addEventListener('componentinitialized', (e) => {
        if (e.detail.name !== 'police-agent') {
          return;
        }
        if (!el.parentNode) {
          return;
        }
        const comp = el.components['police-agent'];
        comp.simComp = this;
        this.police.push(comp);
      });
    }
  },

  // ── Public: called by citizen-agent when it wants to commit a crime ───────
  attemptCrime(attacker) {
    if (this.data.paused) {
      return;
    }
    const aPos = attacker.el.object3D.position;

    let victim = null;
    let best = Infinity;
    this.citizens.forEach((c) => {
      if (c === attacker || c.state !== CS.WANDERING) {
        return;
      }
      const d = dist2D(c.el.object3D.position, aPos);
      if (d < 12 && d < best) {
        best = d;
        victim = c;
      }
    });
    if (!victim) {
      return;
    }

    attacker.flee();
    victim.die();

    const scene = { x: aPos.x, z: aPos.z, ts: Date.now() };
    this.pendingCrimes.push(scene);
    this.stats.total++;

    this._spawnVFX(aPos, victim.el.object3D.position);
    this._dispatch(scene);
    this._broadcast();
  },

  // Police is on the road, criminals on the sidewalk → extended detection
  // range so an arrest from the kerb still works.
  tryArrest(policePos) {
    this.citizens.forEach((c) => {
      if (
        c.state === CS.FLEEING &&
        dist2D(c.el.object3D.position, policePos) < 20
      ) {
        c.arrest();
      }
    });
  },

  // Dispatch the police whose ROUTE has the closest point to the crime —
  // not the police who is currently closest. This way police always responds
  // by driving on a road they can actually reach (no off-road shortcuts).
  _dispatch(scene) {
    const idle = this.police.filter((p) => p.state === PS.PATROLLING);
    if (!idle.length) {
      return;
    }

    let bestPolice = null;
    let bestDist = Infinity;
    let bestPoint = null;

    idle.forEach((p) => {
      const route = p.route;
      if (!route || route.length === 0) {
        return;
      }
      route.forEach((wp) => {
        const d = (wp.x - scene.x) ** 2 + (wp.z - scene.z) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestPolice = p;
          bestPoint = wp;
        }
      });
    });

    if (bestPolice && bestPoint) {
      bestPolice.respondTo(scene, bestPoint);
    }
  },

  _spawnVFX(aPos, vPos) {
    const s = this.el.sceneEl;
    const tag = (el) => {
      el.classList.add(SPAWN_CLASS);
      return el;
    };

    // Red burst at attacker
    const burst = tag(document.createElement('a-sphere'));
    burst.setAttribute('radius', '0.35');
    burst.setAttribute('position', `${aPos.x} 1.6 ${aPos.z}`);
    burst.setAttribute('color', '#ff2200');
    burst.setAttribute(
      'material',
      'opacity:1;emissive:#ff2200;emissiveIntensity:3;transparent:true'
    );
    burst.setAttribute(
      'animation__s',
      'property:scale;to:5 5 5;dur:450;easing:easeOutQuad'
    );
    burst.setAttribute(
      'animation__f',
      'property:material.opacity;to:0;dur:500;easing:easeInQuad'
    );
    s.appendChild(burst);
    setTimeout(() => burst.remove(), 600);

    // Bullet attacker → victim
    const bullet = tag(document.createElement('a-sphere'));
    const dur = Math.max(150, dist2D(aPos, vPos) * 65);
    bullet.setAttribute('radius', '0.09');
    bullet.setAttribute('position', `${aPos.x} 1.3 ${aPos.z}`);
    bullet.setAttribute('color', '#ffee00');
    bullet.setAttribute('material', 'emissive:#ffee00;emissiveIntensity:5');
    bullet.setAttribute(
      'animation',
      `property:position;to:${vPos.x} 1.3 ${vPos.z};dur:${dur};easing:linear`
    );
    s.appendChild(bullet);
    setTimeout(() => bullet.remove(), dur + 100);

    // Floating crime label
    const label = tag(document.createElement('a-entity'));
    label.setAttribute('position', `${aPos.x} 4 ${aPos.z}`);
    label.setAttribute('look-at', '[camera]');
    label.innerHTML = `
      <a-plane width="2.6" height="0.65" color="#cc0000"
        material="opacity:0.92;transparent:true"
        animation__rise="property:position;to:0 1 0;dur:2500;easing:easeOutQuad"
        animation__fade="property:material.opacity;to:0;dur:2000;delay:800;easing:linear">
      </a-plane>
      <a-text value="⚠ HOMICIDE" color="#ffffff" align="center" width="4" position="0 0 0.02"></a-text>`;
    s.appendChild(label);
    setTimeout(() => label.remove(), 3100);

    // Brief red fill light
    const flash = tag(document.createElement('a-light'));
    flash.setAttribute('type', 'point');
    flash.setAttribute('color', '#ff1100');
    flash.setAttribute('intensity', '4');
    flash.setAttribute('distance', '12');
    flash.setAttribute('position', `${aPos.x} 2 ${aPos.z}`);
    flash.setAttribute(
      'animation',
      'property:light.intensity;to:0;dur:1500;easing:easeInQuad'
    );
    s.appendChild(flash);
    setTimeout(() => flash.remove(), 1600);

    // Notify any listeners (the React panel)
    s.emit('city-crime', { x: aPos.x, z: aPos.z });
  },

  _broadcast() {
    const { total, resolved, avgResponseMs } = this.stats;
    window.dispatchEvent(
      new CustomEvent('city-stats', {
        detail: {
          total,
          resolved,
          pending: this.pendingCrimes.length,
          avgResponseMs: Math.round(avgResponseMs),
          policeCount: this.data.policeCount
        }
      })
    );
  },

  tick() {
    if (this.data.paused) {
      return;
    }
    this.pendingCrimes = this.pendingCrimes.filter((crime) => {
      // A crime is resolved when the cop dispatched FOR THAT crime arrives
      // at-scene. Reference match (not distance) — the crime point can be
      // 30-50m off the nearest drivable road for sidewalk-spawned crimes,
      // so a fixed 25m radius would leave them stuck pending forever even
      // though the cop did its job.
      const resolved = this.police.some(
        (p) => p.state === PS.AT_SCENE && p.crimeScene === crime
      );
      if (resolved) {
        this.stats.resolved++;
        if (crime.ts) {
          const rt = Date.now() - crime.ts;
          this.stats._rtAcc += rt;
          this.stats._rtCount += 1;
          this.stats.avgResponseMs = this.stats._rtAcc / this.stats._rtCount;
        }
        this._broadcast();
        return false;
      }
      return true;
    });
  }
});
