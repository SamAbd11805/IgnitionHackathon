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
const ALL_NODE_IDS = Object.keys(GRAPH.nodes);

// Project a crime location onto the nearest road lane (drop-off point).
// Used so the police drives on roads first, then approaches the crime
// from the closest legal road position.
function nearestRoadApproachPoint(crime) {
  const { x, z } = crime;
  if (Math.abs(x) > Math.abs(z)) {
    // Closer to E or W sidewalk → drop off on N-S road
    return { x: x < 0 ? -LANE_OFFSET : LANE_OFFSET, z };
  }
  // Closer to N or S sidewalk → drop off on E-W road
  return { x, z: z < 0 ? -LANE_OFFSET : LANE_OFFSET };
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

    // Pick a random spawn node and snap there
    this.currentNode =
      ALL_NODE_IDS[Math.floor(Math.random() * ALL_NODE_IDS.length)];
    const n = GRAPH.nodes[this.currentNode];
    this.el.object3D.position.set(n.x, 0, n.z);
    this.targetNode = this._pickNext(this.currentNode, null);
  },

  _pickNext(currentId, previousId) {
    const neighbors = GRAPH.adj[currentId] || [];
    const choices = neighbors.filter((n) => n !== previousId);
    if (choices.length === 0) {
      return previousId;
    }
    return choices[Math.floor(Math.random() * choices.length)];
  },

  tick(t, delta) {
    if (this.state === CS.DEAD || this.state === CS.ARRESTED) {
      return;
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

    // Move toward target node
    const target = GRAPH.nodes[this.targetNode];
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
    // Pick a far-away node to flee toward
    const here = this.el.object3D.position;
    let farthest = ALL_NODE_IDS[0];
    let farDist = 0;
    ALL_NODE_IDS.forEach((id) => {
      const d = dist2D(GRAPH.nodes[id], here);
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

    this.route = POLICE_ROUTES[this.data.routeIndex % POLICE_ROUTES.length];
    this.waypointIdx = 0;

    // Snap to first waypoint
    const wp = this.route[0];
    this.el.object3D.position.set(wp.x, 0, wp.z);

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

  respondTo(scene) {
    this.state = PS.RESPONDING;
    this.crimeScene = scene;
    this.dropOffPoint = nearestRoadApproachPoint(scene);
    this.responseStage = 'driving'; // 'driving' (on road) → 'approaching' (off-road)
    this.sirenEl.setAttribute('intensity', '4');
  },

  tick(t, delta) {
    const dt = delta / 1000;
    const pos = this.el.object3D.position;

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
    // When responding: first drive on road to the drop-off point,
    // then approach the actual crime location at reduced speed.
    let target = null;
    let spd = this.data.speed;
    if (this.state === PS.PATROLLING) {
      target = this.route[this.waypointIdx] || null;
    } else if (this.state === PS.RESPONDING) {
      if (this.responseStage === 'driving') {
        target = this.dropOffPoint;
        spd = this.data.speed * 1.8; // fast on road, sirens blaring
      } else {
        target = this.crimeScene;
        spd = this.data.speed * 0.6; // slow approach off-road
      }
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
        if (this.responseStage === 'driving') {
          // Arrived at road drop-off; switch to off-road approach
          this.responseStage = 'approaching';
        } else {
          // Arrived at the crime scene
          this.state = PS.AT_SCENE;
          this.atSceneTimer = 0;
          this.sirenEl.setAttribute('intensity', '1.5');
          if (this.simComp) {
            this.simComp.tryArrest(pos);
          }
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
    spawnCity: { type: 'boolean', default: true }
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

    if (this.el.sceneEl.hasLoaded) {
      this._spawn();
    } else {
      this.el.sceneEl.addEventListener('loaded', () => this._spawn());
    }
  },

  _spawn() {
    if (this.data.spawnCity) {
      this._spawnCity();
    }
    this._spawnAgents();
    this._broadcast();
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

    // Citizens — random spawn nodes on the sidewalk graph
    for (let i = 0; i < this.data.citizenCount; i++) {
      const el = document.createElement('a-entity');
      el.classList.add(SPAWN_CLASS);
      el.setAttribute('mixin', this._CHAR_MIXINS[i % this._CHAR_MIXINS.length]);
      el.setAttribute('scale', '0.85 0.85 0.85');
      el.setAttribute('citizen-agent', {
        speed: this.data.citizenSpeed + rand(-0.3, 0.3),
        crimeRate: this.data.crimeRate
      });
      scene.appendChild(el);

      el.addEventListener('componentinitialized', (e) => {
        if (e.detail.name !== 'citizen-agent') {
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
      el.setAttribute('scale', '0.5 0.5 0.5');
      el.setAttribute('police-agent', {
        speed: this.data.policeSpeed,
        routeIndex: i % POLICE_ROUTES.length
      });
      scene.appendChild(el);

      el.addEventListener('componentinitialized', (e) => {
        if (e.detail.name !== 'police-agent') {
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

  tryArrest(policePos) {
    this.citizens.forEach((c) => {
      if (
        c.state === CS.FLEEING &&
        dist2D(c.el.object3D.position, policePos) < 8
      ) {
        c.arrest();
      }
    });
  },

  _dispatch(scene) {
    const idle = this.police.filter((p) => p.state === PS.PATROLLING);
    if (!idle.length) {
      return;
    }
    let nearest = idle[0];
    let nearDist = dist2D(idle[0].el.object3D.position, scene);
    idle.slice(1).forEach((p) => {
      const d = dist2D(p.el.object3D.position, scene);
      if (d < nearDist) {
        nearDist = d;
        nearest = p;
      }
    });
    nearest.respondTo(scene);
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
      const resolved = this.police.some(
        (p) =>
          p.state === PS.AT_SCENE && dist2D(p.el.object3D.position, crime) < 6
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
