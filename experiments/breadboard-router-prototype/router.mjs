/**
 * router.mjs — Breadboard auto-router (headless, Node.js ESM module)
 *
 * Algorithm:
 *   Placement  — simulated annealing (Kirkpatrick et al. 1983)
 *   Routing    — A-star/Lee maze router (Lee 1961)
 *
 * Usage:
 *   import { route } from './router.mjs';
 *   const solution = route(problem, { iterations: 900, seed: 42 });
 *
 * Input  schema: see `sampleProblem` at the bottom of this file.
 * Output schema: { ok, metrics, placement, wires, validation, log }
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const HOLE_PITCH = 28; // standard 0.1 in breadboard pitch in SVG units
const DEFAULT_ROUTER_SETTINGS = {
  attempts: 3,
  iterations: 360,
  maxJumperHoles: 10,
  jumperPenalty: 240,
  crossingPenalty: 700,
  overlapPenalty: 1200,
  objectiveJumperPenalty: 180,
  objectiveCrossingPenalty: 450
};

// ─── Module-level working state (set by route()) ─────────────────────────────

let state;
let _silent = false; // suppresses expensive per-iteration cost computations during SA
let routerSettings = { ...DEFAULT_ROUTER_SETTINGS };

/** Convenience: current board config */
function boardConfig() { return state.boardModel.config; }
/** Effective hole pitch (from config or default) */
function hp() { return boardConfig().holePitch || HOLE_PITCH; }

// ─── Data model classes ───────────────────────────────────────────────────────

class BreadboardModel {
  #byId;
  #byRowCol;

  constructor(config) {
    this.config = structuredClone(config);
    this.holes = this.#createHoles();
    this.#byId = new Map(this.holes.map(h => [h.id, h]));
    this.#byRowCol = new Map(this.holes.map(h => [`${h.row}:${h.col}`, h]));
  }

  get center() {
    const c = this.config;
    const pitch = c.holePitch || HOLE_PITCH;
    return {
      x: c.x + c.pad + ((c.cols - 1) * pitch) / 2,
      y: c.y + c.pad + ((c.rows.length - 1) * pitch + c.midGap) / 2
    };
  }

  get rect() {
    const c = this.config;
    const pitch = c.holePitch || HOLE_PITCH;
    return rect(
      c.x, c.y,
      c.pad * 2 + (c.cols - 1) * pitch,
      c.pad * 2 + (c.rows.length - 1) * pitch + c.midGap
    );
  }

  edgeX(side) {
    const c = this.config;
    const pitch = c.holePitch || HOLE_PITCH;
    return side === "left" ? c.x : c.x + c.pad * 2 + (c.cols - 1) * pitch;
  }

  freeHoles() { return this.holes.filter(h => !h.occupiedBy); }
  holeAt(col, row) { return this.#byRowCol.get(`${row}:${col}`) || null; }
  holeById(id) { return this.#byId.get(id) || null; }
  clearOccupancy() { for (const h of this.holes) h.occupiedBy = null; }

  #createHoles() {
    const holes = [];
    const c = this.config;
    const pitch = c.holePitch || HOLE_PITCH;
    const topRows = Math.ceil(c.rows.length / 2);
    for (let col = 0; col < c.cols; col++) {
      for (let r = 0; r < c.rows.length; r++) {
        const group = r < topRows ? "top" : "bottom";
        const yGap = r < topRows ? 0 : c.midGap;
        holes.push({
          id: `${c.rows[r]}${col + 1}`,
          row: c.rows[r],
          col: col + 1,
          group,
          bus: `${group}:${col + 1}`,
          x: c.x + c.pad + col * pitch,
          y: c.y + c.pad + r * pitch + yGap,
          occupiedBy: null
        });
      }
    }
    return holes;
  }
}

class PartModel {
  static fromSpec(spec) { return new PartModel(spec); }

  constructor(spec) {
    Object.assign(this, structuredClone(spec));
    this.placed = false;
    this.holes = [];
    this.pinPoints = null;
  }

  get isBoardPlaceable() { return this.role === "board"; }
  get isPeripheral() { return this.role === "peripheral"; }
  get activeNets() { return this.nets.filter(n => n && !n.startsWith("unused")); }

  resetFloatingPosition() {
    if (!this.isBoardPlaceable) return;
    const c = boardConfig();
    this.x = c.x + Math.random() * 240;
    this.y = c.y + Math.random() * 480;
    this.releasePlacement();
  }

  releasePlacement() {
    this.placed = false;
    this.holes = [];
    this.pinPoints = null;
  }

  snapshot() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      placed: this.placed,
      holes: [...(this.holes || [])],
      pinPoints: structuredClone(this.pinPoints)
    };
  }

  restore(snapshot) {
    this.x = snapshot.x;
    this.y = snapshot.y;
    this.placed = snapshot.placed;
    this.holes = [...(snapshot.holes || [])];
    this.pinPoints = structuredClone(snapshot.pinPoints);
  }
}

class WirePath {
  constructor(net, points, kind) {
    this.net = net;
    this.points = points;
    this.kind = kind;
  }

  get segments() { return segmentsForPoints(this.points); }

  get length() {
    let total = 0;
    for (let i = 1; i < this.points.length; i++) total += manhattan(this.points[i - 1], this.points[i]);
    return total;
  }
}

class RouterState {
  #partById;
  #partsByNet;

  constructor(partSpecs, boardSpec) {
    this.boardModel = new BreadboardModel(boardSpec);
    this.parts = partSpecs.map(PartModel.fromSpec);
    this.#partById = new Map(this.parts.map(p => [p.id, p]));
    this.#partsByNet = new Map();
    for (const part of this.parts) {
      for (const net of part.activeNets) {
        if (!this.#partsByNet.has(net)) this.#partsByNet.set(net, []);
        this.#partsByNet.get(net).push(part);
      }
    }
    this.wires = [];
    this.rats = [];
    this.usedBuses = new Map();
    this.netAnchors = new Map();
    this.peripheralLanes = new Map();
    this.routeSegments = [];
    this.busGraph = null;
    this.validation = [];
    this.log = [];
    this.metrics = {};
  }

  get holes() { return this.boardModel.holes; }
  get boardParts() { return this.parts.filter(p => p.isBoardPlaceable); }
  get placedBoardParts() { return this.boardParts.filter(p => p.placed); }
  get peripheralParts() { return this.parts.filter(p => p.isPeripheral); }
  get activeNets() { return [...this.#partsByNet.keys()]; }

  findPart(id) { return this.#partById.get(id) || null; }
  partsForNet(net) { return this.#partsByNet.get(net) || []; }

  resetBoardPlacement() {
    this.boardModel.clearOccupancy();
    this.busGraph = null;
    for (const p of this.boardParts) p.releasePlacement();
  }
}

class MinHeap {
  constructor(compare) { this.compare = compare; this.items = []; }
  size() { return this.items.length; }

  push(item) {
    this.items.push(item);
    this.#bubbleUp(this.items.length - 1);
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last !== undefined) {
      this.items[0] = last;
      this.#bubbleDown(0);
    }
    return first;
  }

  #bubbleUp(i) {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.compare(this.items[parent], this.items[i]) <= 0) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  #bubbleDown(i) {
    while (true) {
      const l = i * 2 + 1, r = l + 1;
      let s = i;
      if (l < this.items.length && this.compare(this.items[l], this.items[s]) < 0) s = l;
      if (r < this.items.length && this.compare(this.items[r], this.items[s]) < 0) s = r;
      if (s === i) break;
      [this.items[i], this.items[s]] = [this.items[s], this.items[i]];
      i = s;
    }
  }
}

class BusGraphCache {
  #buses;
  #edges;

  constructor(routerState) {
    this.#buses = new Map();
    for (const hole of routerState.holes) {
      if (!this.#buses.has(hole.bus)) this.#buses.set(hole.bus, []);
      this.#buses.get(hole.bus).push(hole);
    }
    this.#edges = this.#buildStaticEdges();
  }

  edgesFrom(bus, start, target) {
    return (this.#edges.get(bus) || [])
      .filter(edge => this.#edgeAvailable(edge, start, target))
      .map(edge => ({
        ...edge,
        cost: edge.baseCost +
          graphSegmentCrossingPenalty(edge.fromHole, edge.toHole) +
          congestionPenalty(edge.fromHole, edge.toHole) +
          occupiedEndpointPenalty(edge.fromHole, start, target) +
          occupiedEndpointPenalty(edge.toHole, start, target)
      }));
  }

  #buildStaticEdges() {
    const graph = new Map([...this.#buses.keys()].map(bus => [bus, []]));
    const busList = [...this.#buses.keys()];
    const maxLength = hp() * routerSettings.maxJumperHoles;

    // Precompute the best physical jumper candidates between breadboard buses.
    // Dijkstra later adds dynamic congestion/crossing costs, so this expensive
    // hole-pair scan is paid once per route attempt instead of once per net.
    for (let i = 0; i < busList.length; i++) {
      for (let j = i + 1; j < busList.length; j++) {
        for (const edge of this.#bestStaticJumpers(busList[i], busList[j], maxLength)) {
          graph.get(edge.from).push(edge);
          graph.get(edge.to).push({
            from: edge.to,
            to: edge.from,
            fromHole: edge.toHole,
            toHole: edge.fromHole,
            baseCost: edge.baseCost
          });
        }
      }
    }
    return graph;
  }

  #bestStaticJumpers(fromBus, toBus, maxLength) {
    const candidates = [];
    for (const fromHole of this.#buses.get(fromBus) || []) {
      for (const toHole of this.#buses.get(toBus) || []) {
        const length = manhattan(fromHole, toHole);
        if (length > maxLength) continue;
        candidates.push({
          from: fromBus,
          to: toBus,
          fromHole,
          toHole,
          baseCost: length + routerSettings.jumperPenalty
        });
      }
    }
    return candidates.toSorted((a, b) => a.baseCost - b.baseCost).slice(0, 5);
  }

  #edgeAvailable(edge, start, target) {
    if (!routeHoleAvailable(edge.fromHole, start, target)) return false;
    if (!routeHoleAvailable(edge.toHole, start, target)) return false;
    return !isBlockedRouteSegment(edge.fromHole, edge.toHole, start, target, true);
  }
}

// ─── Internal log ─────────────────────────────────────────────────────────────

function log(message) {
  state.log.push(`${new Date().toISOString().slice(11, 19)}  ${message}`);
}

// ─── Geometry primitives ──────────────────────────────────────────────────────

function rect(x, y, w, h) { return { x, y, w, h }; }
function rectsOverlap(a, b, margin = 0) {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x &&
         a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}
function unique(values) { return [...new Set(values)]; }
function manhattan(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
function between(value, a, b) { return value >= Math.min(a, b) && value <= Math.max(a, b); }
function rangesOverlap(a1, a2, b1, b2) {
  return Math.max(Math.min(a1, a2), Math.min(b1, b2)) <= Math.min(Math.max(a1, a2), Math.max(b1, b2));
}
function samePoint(a, b) {
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}
function direction(a, b) {
  if (a.x < b.x) return "E"; if (a.x > b.x) return "W";
  if (a.y < b.y) return "S"; return "N";
}

// ─── Board geometry helpers ───────────────────────────────────────────────────

function boardCenter() {
  const c = boardConfig();
  const pitch = hp();
  return {
    x: c.x + c.pad + ((c.cols - 1) * pitch) / 2,
    y: c.y + c.pad + ((c.rows.length - 1) * pitch + c.midGap) / 2
  };
}

function boardRect() {
  const c = boardConfig();
  const pitch = hp();
  return rect(
    c.x, c.y,
    c.pad * 2 + (c.cols - 1) * pitch,
    c.pad * 2 + (c.rows.length - 1) * pitch + c.midGap
  );
}

function boardEdgeX(side) {
  const c = boardConfig();
  const pitch = hp();
  return side === "left" ? c.x : c.x + c.pad * 2 + (c.cols - 1) * pitch;
}

function distanceToBoardCenter(point) { return manhattan(point, boardCenter()); }

function segmentCrossesBoardCenter(a, b) {
  const c = boardCenter();
  return Math.abs(((b.y - a.y) * c.x - (b.x - a.x) * c.y + b.x * a.y - b.y * a.x) /
    Math.max(1, manhattan(a, b))) < 30;
}

// ─── Hole helpers ─────────────────────────────────────────────────────────────

function freeHoles() { return state.boardModel.freeHoles(); }
function holeAt(col, row) { return state.boardModel.holeAt(col, row); }
function holeById(id) { return state.boardModel.holeById(id); }

function addNetAnchor(net, hole) {
  if (!state.netAnchors.has(net)) state.netAnchors.set(net, []);
  const anchors = state.netAnchors.get(net);
  if (!anchors.some(h => h.id === hole.id)) anchors.push(hole);
}

// ─── Bus helpers ──────────────────────────────────────────────────────────────

function busNetMap() {
  const owners = new Map();
  for (const [net, anchors] of state.netAnchors.entries()) {
    if (!net || net.startsWith("unused")) continue;
    for (const anchor of anchors) {
      if (!owners.has(anchor.bus)) owners.set(anchor.bus, new Set());
      owners.get(anchor.bus).add(net);
    }
  }
  return owners;
}

function busNetConflicts() {
  const holesByBusNet = new Map();
  for (const [net, anchors] of state.netAnchors.entries()) {
    if (!net || net.startsWith("unused")) continue;
    for (const anchor of anchors) {
      if (!holesByBusNet.has(anchor.bus)) holesByBusNet.set(anchor.bus, new Map());
      const byNet = holesByBusNet.get(anchor.bus);
      if (!byNet.has(net)) byNet.set(net, []);
      byNet.get(net).push(anchor.id);
    }
  }
  const conflicts = [];
  for (const [bus, byNet] of holesByBusNet.entries()) {
    if (byNet.size <= 1) continue;
    conflicts.push({
      bus, nets: [...byNet.keys()],
      holes: [...byNet.entries()].flatMap(([net, holes]) => holes.map(h => `${net}:${h}`))
    });
  }
  return conflicts;
}

function busAvailableForNet(bus, net, busOwners = busNetMap()) {
  const owners = busOwners.get(bus);
  return !owners || owners.size === 0 || (owners.size === 1 && owners.has(net));
}

function busCongestionPenalty(bus) {
  return state.usedBuses.get(bus)?.length || 0;
}

// ─── Part helpers ─────────────────────────────────────────────────────────────

function netDegree(part) {
  return part.nets.reduce((sum, net) => sum + state.partsForNet(net).length, 0);
}

function pinPointsForPeripheral(part) {
  const count = part.pins.length;
  return part.pins.map((pin, i) => ({
    x: part.x + ((i + 1) * part.w) / (count + 1),
    y: part.y + part.h,
    label: `${part.id}:${pin}`
  }));
}

function pinPoint(part, i) {
  if (part.pinPoints && part.pinPoints[i]) return part.pinPoints[i];
  if (part.isPeripheral) {
    part.pinPoints = pinPointsForPeripheral(part);
    return part.pinPoints[i];
  }
  return { x: part.x + part.w / 2, y: part.y + part.h / 2 };
}

function sideFor(part) {
  return part.x < boardConfig().x ? "left" : "right";
}

// ─── Candidate generation ─────────────────────────────────────────────────────

function generateCandidates(part) {
  if (part.pins.length === 2 && part.bendable) return generateTwoPinBendableCandidates(part);
  if (part.pins.length === 3 && (part.family === "transistor" || part.family === "potentiometer")) return generateTransistorCandidates(part);
  return generateRigidCandidates(part);
}

function generateTwoPinBendableCandidates(part) {
  const busOwners = busNetMap();
  const candidates = [];
  for (const h1 of freeHoles()) {
    for (const span of [2, 3, 4, 5, 6, 7, 8]) {
      const h2 = holeAt(h1.col + span, h1.row);
      if (!h2 || h2.occupiedBy || h1.bus === h2.bus) continue;
      candidates.push({
        strategy: "bendable",
        holes: [h1, h2],
        x: (h1.x + h2.x) / 2 - part.w / 2,
        y: (h1.y + h2.y) / 2 - part.h / 2
      });
    }
  }
  return candidates.filter(c => onBoard(c, part) && !overlaps(c, part) && candidateRespectsBusOwnership(part, c, busOwners));
}

function generateTransistorCandidates(part) {
  const busOwners = busNetMap();
  const candidates = [];
  for (const h1 of freeHoles()) {
    const h2 = holeAt(h1.col + 1, h1.row);
    const h3 = holeAt(h1.col + 2, h1.row);
    if (!h2 || !h3 || h2.occupiedBy || h3.occupiedBy) continue;
    candidates.push({
      strategy: "rigid-to92",
      holes: [h1, h2, h3],
      x: h2.x - part.w / 2,
      y: h2.y - part.h + 10
    });
  }
  return candidates.filter(c => onBoard(c, part) && !overlaps(c, part) && candidateRespectsBusOwnership(part, c, busOwners));
}

function generateRigidCandidates(part) {
  const busOwners = busNetMap();
  const candidates = [];
  for (const h of freeHoles()) {
    candidates.push({
      strategy: "rigid",
      holes: [h],
      x: h.x - part.w / 2,
      y: h.y - part.h / 2
    });
  }
  return candidates.filter(c => onBoard(c, part) && !overlaps(c, part) && candidateRespectsBusOwnership(part, c, busOwners));
}

function candidateRespectsBusOwnership(part, candidate, busOwners) {
  const candidateOwners = new Map();
  for (let i = 0; i < candidate.holes.length; i++) {
    const hole = candidate.holes[i];
    const net = part.nets[i];
    if (!net || net.startsWith("unused")) continue;
    const existing = busOwners.get(hole.bus);
    if (existing && (existing.size > 1 || !existing.has(net))) return false;
    if (!candidateOwners.has(hole.bus)) candidateOwners.set(hole.bus, new Set());
    candidateOwners.get(hole.bus).add(net);
  }
  return [...candidateOwners.values()].every(nets => nets.size <= 1);
}

// ─── Placement scoring ────────────────────────────────────────────────────────

function scorePlacement(part, candidate) {
  let score = 0;
  candidate.holes.forEach((hole, i) => {
    const net = part.nets[i];
    const anchors = state.netAnchors.get(net) || [];
    if (anchors.length) {
      score += Math.min(...anchors.map(a => manhattan(hole, a)));
    } else {
      score += distanceToBoardCenter(hole) * 0.35;
    }
    score += busCongestionPenalty(hole.bus) * 25;
  });
  score += crossingEstimate(candidate) * 8;
  return score;
}

function crossingEstimate(candidate) {
  let crossings = 0;
  for (const hole of candidate.holes) {
    for (const anchors of state.netAnchors.values()) {
      for (const anchor of anchors) {
        if (segmentCrossesBoardCenter(hole, anchor)) crossings++;
      }
    }
  }
  return crossings;
}

function onBoard(candidate, part) {
  const c = boardConfig();
  const pitch = hp();
  const minX = c.x + 8;
  const maxX = c.x + c.pad * 2 + (c.cols - 1) * pitch - part.w + 20;
  const minY = c.y + 8;
  const maxY = c.y + c.pad * 2 + (c.rows.length - 1) * pitch + c.midGap - part.h + 20;
  return candidate.x >= minX && candidate.x <= maxX && candidate.y >= minY && candidate.y <= maxY;
}

function overlaps(candidate, part) {
  const a = rect(candidate.x, candidate.y, part.w, part.h);
  return state.placedBoardParts.some(other => {
    if (other === part) return false;
    return rectsOverlap(a, rect(other.x, other.y, other.w, other.h), 6);
  });
}

// ─── Placement apply / release ────────────────────────────────────────────────

function applyPlacement(part, candidate) {
  part.x = candidate.x;
  part.y = candidate.y;
  part.placed = true;
  part.holes = candidate.holes.map(h => h.id);
  part.pinPoints = candidate.holes.map(h => ({ x: h.x, y: h.y, hole: h.id }));
  candidate.holes.forEach((hole, i) => {
    hole.occupiedBy = `${part.id}:${part.pins[i]}`;
    addNetAnchor(part.nets[i], hole);
    if (!state.usedBuses.has(hole.bus)) state.usedBuses.set(hole.bus, []);
    state.usedBuses.get(hole.bus).push(part.id);
  });
}

function releasePart(part) {
  if (!part.holes) return;
  for (const id of part.holes) {
    const hole = holeById(id);
    if (hole) hole.occupiedBy = null;
  }
  part.placed = false;
  part.holes = [];
  rebuildAnchors();
}

function rebuildAnchors() {
  state.netAnchors.clear();
  state.usedBuses.clear();
  for (const part of state.placedBoardParts) {
    part.holes.forEach((id, i) => {
      const hole = holeById(id);
      if (!hole) return;
      addNetAnchor(part.nets[i], hole);
      if (!state.usedBuses.has(hole.bus)) state.usedBuses.set(hole.bus, []);
      state.usedBuses.get(hole.bus).push(part.id);
    });
  }
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

function snapshotLayout() {
  return { parts: state.parts.map(p => p.snapshot()) };
}

function restoreLayout(snapshot) {
  state.boardModel.clearOccupancy();
  for (const saved of snapshot.parts) {
    const part = state.findPart(saved.id);
    if (!part) continue;
    part.restore(saved);
    part.holes.forEach((id, i) => {
      const hole = holeById(id);
      if (hole) hole.occupiedBy = `${part.id}:${part.pins[i] || ""}`;
    });
  }
  rebuildAnchors();
}

function snapshotRouteState() {
  return {
    wires: structuredClone(state.wires),
    rats: structuredClone(state.rats),
    routeSegments: structuredClone(state.routeSegments),
    validation: structuredClone(state.validation)
  };
}

function restoreRouteState(snapshot) {
  state.wires = structuredClone(snapshot.wires);
  state.rats = structuredClone(snapshot.rats);
  state.routeSegments = structuredClone(snapshot.routeSegments);
  state.validation = structuredClone(snapshot.validation);
}

// ─── Peripheral routing ───────────────────────────────────────────────────────

function allocatePeripheralAnchors(emitLog = false) {
  state.wires = [];
  state.rats = [];
  state.peripheralLanes.clear();
  rebuildAnchors();
  for (const part of state.peripheralParts) {
    part.pinPoints = pinPointsForPeripheral(part);
    for (const request of activePeripheralPins(part)) {
      const lane = laneForPeripheralNet(request.net, part, request.pin, emitLog);
      if (lane) {
        addNetAnchor(request.net, lane);
        state.wires.push(createPeripheralWire(request.net, request.pin, lane, part));
      } else {
        state.rats.push({ net: request.net, a: request.pin, b: boardCenter() });
      }
    }
  }
}

function activePeripheralPins(part) {
  return part.pinPoints
    .map((pin, i) => ({ pin, net: part.nets[i] }))
    .filter(r => r.net && !r.net.startsWith("unused"));
}

function createPeripheralWire(net, pin, lane, part) {
  return new WirePath(net, orthogonal(pin, lane, sideFor(part)), "peripheral");
}

function laneForPeripheralNet(net, part, pin, emitLog) {
  const side = sideFor(part);
  const key = `${net}:${side}`;
  if (state.peripheralLanes.has(key)) return state.peripheralLanes.get(key);
  const lane = allocateLane(net, side, pin);
  if (lane) {
    state.peripheralLanes.set(key, lane);
    if (emitLog) log(`lane ${net}: allocated ${lane.id} on ${side} edge`);
  }
  return lane;
}

function allocateLane(net, side, pin) {
  const busOwners = busNetMap();
  const ranked = peripheralLaneCandidates(net, busOwners)
    .toSorted((a, b) => laneCost(a, side, pin, busOwners) - laneCost(b, side, pin, busOwners));
  return ranked[0] || null;
}

function peripheralLaneCandidates(net, busOwners) {
  return freeHoles().filter(h => busAvailableForNet(h.bus, net, busOwners));
}

function laneCost(hole, side, pin, busOwners) {
  const edge = boardEdgeX(side);
  const owners = busOwners.get(hole.bus);
  const sameNetBonus = owners && owners.size === 1 ? -180 : 0;
  const projected = orthogonal(pin, hole, side);
  return Math.abs(hole.x - edge) * 3
    + Math.abs(hole.y - pin.y) * 1.4
    + busCongestionPenalty(hole.bus) * 100
    + peripheralWireConflictCost(projected)
    + sameNetBonus;
}

function peripheralWireConflictCost(points) {
  if (_silent) return 0; // skip expensive O(n²) check during SA iterations
  const projectedSegments = segmentsForPoints(points);
  const existingSegments = segmentsForWires(state.wires.filter(w => w.kind === "peripheral"));
  let cost = 0;
  for (const a of projectedSegments) {
    for (const b of existingSegments) {
      if (segmentsShareEndpoint(a, b)) continue;
      if (segmentsOverlap(a, b)) cost += 1200;
      if (segmentsCross(a, b)) cost += 900;
    }
  }
  return cost;
}

function orthogonal(a, b, side) {
  const offset = side === "left" ? -60 : 60;
  const elbowX = side === "left" ? Math.min(a.x, b.x) + offset : Math.max(a.x, b.x) + offset;
  return [{ x: a.x, y: a.y }, { x: elbowX, y: a.y }, { x: elbowX, y: b.y }, { x: b.x, y: b.y }];
}

// ─── Net graph helpers ────────────────────────────────────────────────────────

function minimumSpanningTree(points) {
  const edges = [];
  const used = new Set([0]);
  while (used.size < points.length) {
    let best = null;
    for (const i of used) {
      for (let j = 0; j < points.length; j++) {
        if (used.has(j)) continue;
        const cost = manhattan(points[i], points[j]);
        if (!best || cost < best.cost) best = { i, j, cost };
      }
    }
    if (!best) break;
    used.add(best.j);
    edges.push([points[best.i], points[best.j]]);
  }
  return edges;
}

function oneAnchorPerBus(anchors) {
  const byBus = new Map();
  for (const anchor of anchors) {
    if (!byBus.has(anchor.bus)) byBus.set(anchor.bus, []);
    byBus.get(anchor.bus).push(anchor);
  }
  return [...byBus.values()].map(group =>
    group.toSorted((a, b) => distanceToBoardCenter(a) - distanceToBoardCenter(b))[0]);
}

function routeNetComplexity(net) {
  return oneAnchorPerBus(state.netAnchors.get(net) || []).length;
}

function routeNetSpan(net) {
  const anchors = oneAnchorPerBus(state.netAnchors.get(net) || []);
  if (anchors.length < 2) return 0;
  const xs = anchors.map(a => a.x), ys = anchors.map(a => a.y);
  return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
}

// ─── Route state management ───────────────────────────────────────────────────

function routeAttemptScore(attempt) {
  const saved = snapshotRouteState();
  restoreRouteState(attempt);
  const score = totalObjective();
  restoreRouteState(saved);
  return score;
}

function resetDetailedRouteAttempt() {
  state.wires = state.wires.filter(w => w.kind === "peripheral");
  state.routeSegments = segmentsForWires(state.wires);
  state.busGraph = new BusGraphCache(state);
  state.rats = [];
  state.validation = [];
  validatePartRoles();
  for (const conflict of busNetConflicts()) {
    state.validation.push({
      net: `bus ${conflict.bus}`, status: "fail",
      reason: `same breadboard bus has multiple nets: ${conflict.nets.join(", ")}`,
      anchors: conflict.holes
    });
  }
}

// ─── Route ordering and routing ───────────────────────────────────────────────

function routeOrders(nets) {
  const uniqueOrders = [];
  const add = order => {
    const key = order.join("|");
    if (!uniqueOrders.some(e => e.key === key)) uniqueOrders.push({ key, order });
  };
  add(nets);
  add([...nets].toSorted((a, b) => routeNetComplexity(a) - routeNetComplexity(b)));
  add([...nets].toSorted((a, b) => routeNetComplexity(b) - routeNetComplexity(a)));
  add([...nets].toSorted((a, b) => routeNetSpan(a) - routeNetSpan(b)));
  add([...nets].toSorted((a, b) => routeNetSpan(b) - routeNetSpan(a)));
  return uniqueOrders.map(e => e.order);
}

function routeNetsInOrder(nets) {
  const saved = snapshotRouteState();
  resetDetailedRouteAttempt();
  for (const net of nets) routeOneNet(net);
  findUnresolvedNets();
  const result = snapshotRouteState();
  restoreRouteState(saved);
  return result;
}

function routeNetsGreedy(nets) {
  const saved = snapshotRouteState();
  resetDetailedRouteAttempt();
  const remaining = [...nets];
  while (remaining.length) {
    let best = null;
    for (const net of remaining) {
      const before = snapshotRouteState();
      routeOneNet(net);
      const score = routeAttemptScore(snapshotRouteState());
      restoreRouteState(before);
      if (!best || score < best.score) best = { net, score };
    }
    routeOneNet(best.net);
    remaining.splice(remaining.indexOf(best.net), 1);
  }
  findUnresolvedNets();
  const result = snapshotRouteState();
  restoreRouteState(saved);
  return result;
}

function routeAllNets(emitLog = true, useGreedy = false) {
  const nets = state.activeNets;
  const attempts = routeOrders(nets).map(order => routeNetsInOrder(order));
  if (useGreedy) attempts.push(routeNetsGreedy(nets)); // greedy is O(n²) routing calls — opt-in only
  const best = attempts.toSorted((a, b) => routeAttemptScore(a) - routeAttemptScore(b))[0]
    || routeNetsInOrder(nets);
  state.wires = best.wires;
  state.rats = best.rats;
  state.routeSegments = best.routeSegments;
  state.validation = best.validation;
  if (emitLog) log(`route: wires=${state.wires.length} unresolved=${state.rats.length} crossings=${wireCrossingCount()}`);
}

function routeOneNet(net) {
  const anchors = state.netAnchors.get(net) || [];
  const busAnchors = oneAnchorPerBus(anchors);
  if (!anchors.length) {
    state.validation.push({ net, status: "fail", reason: "no breadboard anchors" });
    return;
  }
  if (busAnchors.length < 2) {
    state.validation.push({ net, status: "ok", reason: "single bus", anchors: anchors.map(a => a.id) });
    return;
  }
  const tree = minimumSpanningTree(busAnchors);
  let failed = false;
  for (const [a, b] of tree) {
    const routes = routeWireSegmentsBetweenHoles(a, b);
    if (routes.length) {
      for (const route of routes) {
        state.wires.push(new WirePath(net, route, "board"));
        state.routeSegments.push(...segmentsForPoints(route));
      }
    } else if (a.bus !== b.bus) {
      state.rats.push({ net, a, b });
      state.validation.push({
        net, status: "fail",
        reason: `graph route failed ${a.id}->${b.id}`,
        anchors: busAnchors.map(h => h.id)
      });
      failed = true;
    }
  }
  if (!failed) {
    state.validation.push({
      net, status: "ok",
      reason: `${busAnchors.length} buses connected`,
      anchors: busAnchors.map(h => h.id)
    });
  }
}

// ─── Maze router (A* with congestion) ────────────────────────────────────────

function routeWireSegmentsBetweenHoles(a, b) {
  if (a.bus === b.bus) return [];
  const graphRoutes = graphRouteBetweenBuses(a, b);
  if (graphRoutes.length) return graphRoutes;
  const mazeRoute = mazeRouteBetweenHoles(a, b);
  return mazeRoute.length > 1 ? [mazeRoute] : [];
}

function graphRouteBetweenBuses(start, target) {
  if (!state.busGraph) state.busGraph = new BusGraphCache(state);
  const routeEdges = shortestBusPath(state.busGraph, start.bus, target.bus, start, target);
  if (!routeEdges.length) return [];
  return routeEdges.map(edge => [edge.fromHole, edge.toHole]);
}

function routeHoleAvailable(hole, start, target) {
  return !hole.occupiedBy || sameHole(hole, start) || sameHole(hole, target);
}

function occupiedEndpointPenalty(hole, start, target) {
  if (!hole.occupiedBy || sameHole(hole, start) || sameHole(hole, target)) return 0;
  return 2000;
}

function graphSegmentCrossingPenalty(a, b) {
  let penalty = 0;
  const segment = [a, b];
  for (const existing of state.routeSegments) {
    if (segmentsOverlap(segment, existing)) penalty += routerSettings.overlapPenalty;
    if (segmentsCross(segment, existing)) penalty += routerSettings.crossingPenalty;
  }
  return penalty;
}

function shortestBusPath(graph, startBus, targetBus, start, target) {
  const open = new MinHeap((a, b) => a.cost - b.cost);
  open.push({ bus: startBus, cost: 0 });
  const best = new Map([[startBus, 0]]);
  const cameFrom = new Map();

  while (open.size()) {
    const current = open.pop();
    // Dijkstra over breadboard buses, where each edge is one candidate jumper.
    if (current.cost !== best.get(current.bus)) continue;
    if (current.bus === targetBus) break;
    for (const edge of graph.edgesFrom(current.bus, start, target)) {
      const cost = current.cost + edge.cost;
      if (cost >= (best.get(edge.to) ?? Infinity)) continue;
      best.set(edge.to, cost);
      cameFrom.set(edge.to, edge);
      open.push({ bus: edge.to, cost });
    }
  }

  if (!cameFrom.has(targetBus)) return [];
  const edges = [];
  let bus = targetBus;
  while (bus !== startBus) {
    const edge = cameFrom.get(bus);
    if (!edge) return [];
    edges.push(edge);
    bus = edge.from;
  }
  return edges.reverse();
}

function sameHole(a, b) {
  return a.id && b.id && a.id === b.id;
}

function mazeRouteBetweenHoles(start, target) {
  const starts = accessPointsForHole(start);
  const targets = accessPointsForHole(target);
  let best = null;
  for (const s of starts) {
    for (const t of targets) {
      let route = mazeRoute(s, t, start, target, false);
      if (!route.length) route = mazeRoute(s, t, start, target, true);
      if (!route.length) continue;
      const fullRoute = [start, ...route, target];
      const cost = routeCost(fullRoute);
      if (!best || cost < best.cost) best = { route: simplifyRoute(fullRoute), cost };
    }
  }
  return best ? best.route : [];
}

function accessPointsForHole(hole) {
  const pitch = hp();
  const points = [
    hole,
    { x: hole.x, y: hole.y - pitch },
    { x: hole.x, y: hole.y + pitch },
    { x: hole.x - pitch, y: hole.y },
    { x: hole.x + pitch, y: hole.y }
  ];
  return points.filter(p => routePointInsideSearchArea(p) && !isBlockedRoutePoint(p, hole, hole));
}

function routeCost(points) {
  let cost = 0;
  for (let i = 1; i < points.length; i++) cost += manhattan(points[i - 1], points[i]);
  for (let i = 2; i < points.length; i++) {
    if (direction(points[i - 2], points[i - 1]) !== direction(points[i - 1], points[i])) cost += 18;
  }
  return cost;
}

function mazeRoute(start, target, trueStart, trueTarget, relaxedKeepout) {
  const grid = routingGrid(start, target);
  const startNode = nodeKey(start.x, start.y);
  const targetNode = nodeKey(target.x, target.y);
  const open = new MinHeap((a, b) => a.f - b.f || a.g - b.g);
  open.push({ key: startNode, x: start.x, y: start.y, g: 0, f: manhattan(start, target), dir: "" });
  const best = new Map([[startNode, 0]]);
  const cameFrom = new Map();

  while (open.size()) {
    const current = open.pop();
    if (current.g !== best.get(current.key)) continue;
    if (current.key === targetNode) return simplifyRoute(reconstructPath(cameFrom, current));
    for (const next of routingNeighbors(current, grid)) {
      if (isBlockedRoutePoint(next, trueStart, trueTarget, relaxedKeepout)) continue;
      if (isBlockedRouteSegment(current, next, trueStart, trueTarget, relaxedKeepout)) continue;
      const dir = direction(current, next);
      const turn = current.dir && current.dir !== dir ? 18 : 0;
      const congestion = congestionPenalty(current, next);
      const g = current.g + manhattan(current, next) + turn + congestion;
      if (g >= (best.get(next.key) ?? Infinity)) continue;
      best.set(next.key, g);
      cameFrom.set(next.key, current);
      open.push({ key: next.key, x: next.x, y: next.y, g, f: g + manhattan(next, target), dir });
    }
  }
  return [];
}

function routingGrid(start, target) {
  const c = boardConfig();
  const pitch = hp();
  const xs = unique([
    ...state.holes.map(h => h.x),
    ...state.holes.flatMap(h => [h.x - pitch, h.x + pitch]),
    ...state.placedBoardParts.flatMap(p => [p.x - 18, p.x + p.w + 18]),
    c.x - 46,
    c.x + c.pad * 2 + (c.cols - 1) * pitch + 46,
    start.x, target.x
  ]).toSorted((a, b) => a - b);
  const ys = unique([
    ...state.holes.map(h => h.y),
    ...state.holes.map(h => h.y - 18),
    ...state.holes.map(h => h.y + 18),
    ...state.holes.flatMap(h => [h.y - pitch, h.y + pitch]),
    ...state.placedBoardParts.flatMap(p => [p.y - 18, p.y + p.h + 18]),
    c.y - 46,
    c.y + c.pad * 2 + (c.rows.length - 1) * pitch + c.midGap + 46,
    start.y, target.y
  ]).toSorted((a, b) => a - b);
  return { xs, ys };
}

function routingNeighbors(current, grid) {
  const xi = grid.xs.indexOf(current.x);
  const yi = grid.ys.indexOf(current.y);
  const neighbors = [];
  if (xi > 0) neighbors.push(pointNode(grid.xs[xi - 1], current.y));
  if (xi < grid.xs.length - 1) neighbors.push(pointNode(grid.xs[xi + 1], current.y));
  if (yi > 0) neighbors.push(pointNode(current.x, grid.ys[yi - 1]));
  if (yi < grid.ys.length - 1) neighbors.push(pointNode(current.x, grid.ys[yi + 1]));
  return neighbors;
}

function pointNode(x, y) { return { x, y, key: nodeKey(x, y) }; }
function nodeKey(x, y) { return `${Math.round(x)},${Math.round(y)}`; }

function isCenterGapPoint(point) {
  const c = boardConfig();
  const pitch = hp();
  const topRows    = Math.ceil(c.rows.length / 2);
  const lastTopY   = c.y + c.pad + (topRows - 1) * pitch;
  const firstBotY  = c.y + c.pad + topRows * pitch + c.midGap;
  const gapTop     = lastTopY  + pitch * 0.3;
  const gapBottom  = firstBotY - pitch * 0.3;
  const boardRight = c.x + c.pad * 2 + (c.cols - 1) * pitch;
  return point.x >= c.x && point.x <= boardRight
      && point.y >  gapTop && point.y < gapBottom;
}

function isBlockedRoutePoint(point, start, target, relaxed = false) {
  if (samePoint(point, start) || samePoint(point, target)) return false;
  if (!routePointInsideSearchArea(point)) return true;
  const margin = relaxed ? 2 : 10;
  return state.placedBoardParts.some(p =>
    pointInRect(point, rect(p.x - margin, p.y - margin, p.w + margin * 2, p.h + margin * 2)));
}

function isBlockedRouteSegment(a, b, start, target, relaxed = false) {
  if (samePoint(a, start) || samePoint(a, target) || samePoint(b, start) || samePoint(b, target)) return false;
  const margin = relaxed ? 2 : 10;
  return state.placedBoardParts.some(p =>
    segmentIntersectsRect(a, b, rect(p.x - margin, p.y - margin, p.w + margin * 2, p.h + margin * 2)));
}

function segmentIntersectsRect(a, b, area) {
  if (pointInRect(a, area) || pointInRect(b, area)) return true;
  if (a.x === b.x) {
    return a.x >= area.x && a.x <= area.x + area.w && rangesOverlap(a.y, b.y, area.y, area.y + area.h);
  }
  if (a.y === b.y) {
    return a.y >= area.y && a.y <= area.y + area.h && rangesOverlap(a.x, b.x, area.x, area.x + area.w);
  }
  const topLeft = { x: area.x, y: area.y };
  const topRight = { x: area.x + area.w, y: area.y };
  const bottomRight = { x: area.x + area.w, y: area.y + area.h };
  const bottomLeft = { x: area.x, y: area.y + area.h };
  return lineSegmentsIntersect(a, b, topLeft, topRight) ||
    lineSegmentsIntersect(a, b, topRight, bottomRight) ||
    lineSegmentsIntersect(a, b, bottomRight, bottomLeft) ||
    lineSegmentsIntersect(a, b, bottomLeft, topLeft);
}

function lineSegmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return o1 === 0 && pointOnSegment(c, a, b) ||
    o2 === 0 && pointOnSegment(d, a, b) ||
    o3 === 0 && pointOnSegment(a, c, d) ||
    o4 === 0 && pointOnSegment(b, c, d);
}

function orientation(a, b, c) {
  // Cross-product sign for segment intersection. Zero means collinear.
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 0.0001) return 0;
  return value > 0 ? 1 : 2;
}

function pointOnSegment(point, a, b) {
  return point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) &&
    point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
}

function routePointInsideSearchArea(point) {
  const c = boardConfig();
  const pitch = hp();
  return point.x >= c.x - 70
    && point.x <= c.x + c.pad * 2 + (c.cols - 1) * pitch + 70
    && point.y >= c.y - 70
    && point.y <= c.y + c.pad * 2 + (c.rows.length - 1) * pitch + c.midGap + 70;
}

function pointInRect(point, area) {
  return point.x >= area.x && point.x <= area.x + area.w && point.y >= area.y && point.y <= area.y + area.h;
}

function congestionPenalty(a, b) {
  let penalty = 0;
  const segment = [a, b];
  for (const existing of state.routeSegments) {
    if (segmentsOverlap(segment, existing)) penalty += routerSettings.overlapPenalty;
    if (segmentsCross(segment, existing)) penalty += routerSettings.crossingPenalty;
  }
  return penalty;
}

function reconstructPath(cameFrom, current) {
  const path = [{ x: current.x, y: current.y }];
  while (cameFrom.has(current.key)) {
    current = cameFrom.get(current.key);
    path.push({ x: current.x, y: current.y });
  }
  return path.reverse();
}

function simplifyRoute(points) {
  if (points.length <= 2) return points;
  const simplified = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = simplified[simplified.length - 1];
    const cur = points[i], next = points[i + 1];
    if ((prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y)) continue;
    simplified.push(cur);
  }
  simplified.push(points[points.length - 1]);
  return simplified;
}

// ─── Wire / segment geometry ──────────────────────────────────────────────────

function segmentsForWires(wires) { return wires.flatMap(w => segmentsForPoints(w.points)); }

function segmentsForPoints(points) {
  const segments = [];
  for (let i = 1; i < points.length; i++) segments.push([points[i - 1], points[i]]);
  return segments;
}

function segmentsOverlap(a, b) {
  const [a1, a2] = a, [b1, b2] = b;
  if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x) return rangesOverlap(a1.y, a2.y, b1.y, b2.y);
  if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y) return rangesOverlap(a1.x, a2.x, b1.x, b2.x);
  return false;
}

function segmentsCross(a, b) {
  const [a1, a2] = a, [b1, b2] = b;
  const av = a1.x === a2.x, bv = b1.x === b2.x;
  if (av === bv) return false;
  const [v1, v2] = av ? a : b;
  const [h1, h2] = av ? b : a;
  return between(v1.x, h1.x, h2.x) && between(h1.y, v1.y, v2.y);
}

function segmentsShareEndpoint(a, b) {
  return samePoint(a[0], b[0]) || samePoint(a[0], b[1]) || samePoint(a[1], b[0]) || samePoint(a[1], b[1]);
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validatePartRoles() {
  for (const part of state.parts) {
    if (part.isBoardPlaceable) {
      if (!part.placed || !part.holes?.length) {
        state.validation.push({ net: part.id, status: "fail", reason: "board-placeable part is not on the breadboard" });
      }
    }
    if (part.isPeripheral && rectsOverlap(rect(part.x, part.y, part.w, part.h), boardRect(), 0)) {
      state.validation.push({ net: part.id, status: "fail", reason: "peripheral overlaps the breadboard" });
    }
  }
}

function findUnresolvedNets() {
  for (const net of state.activeNets) {
    const pins = [];
    for (const part of state.parts) {
      part.nets.forEach((n, i) => { if (n === net) pins.push(pinPoint(part, i)); });
    }
    const anchors = state.netAnchors.get(net) || [];
    if (pins.length > 1 && anchors.length === 0) {
      state.rats.push({ net, a: pins[0], b: pins[1] });
    }
  }
}

// ─── Metrics and objective functions ─────────────────────────────────────────

function computeMetrics() {
  const wireLength = state.wires.reduce((sum, wire) => {
    for (let i = 1; i < wire.points.length; i++) sum += manhattan(wire.points[i - 1], wire.points[i]);
    return sum;
  }, 0);
  state.metrics = {
    "placed parts": state.placedBoardParts.length,
    "peripherals": state.peripheralParts.length,
    "jumpers": state.wires.length,
    "wire length": Math.round(wireLength),
    "crossings": wireCrossingCount(),
    "unresolved nets": state.rats.length,
    "failed nets": state.validation.filter(v => v.status === "fail").length,
    "objective": Math.round(totalObjective())
  };
}

function totalObjective() {
  const length = state.wires.reduce((sum, wire) => {
    for (let i = 1; i < wire.points.length; i++) sum += manhattan(wire.points[i - 1], wire.points[i]);
    return sum;
  }, 0);
  return length
    + state.wires.length * routerSettings.objectiveJumperPenalty
    + wireCrossingCount() * routerSettings.objectiveCrossingPenalty
    + state.rats.length * 10000
    + overlapCount() * 2500
    + busNetConflicts().length * 50000;
}

function estimatedPlacementObjective() {
  let score = overlapCount() * 2500 + busNetConflicts().length * 50000;
  for (const net of state.activeNets) {
    const anchors = oneAnchorPerBus(state.netAnchors.get(net) || []);
    if (anchors.length < 2) continue;
    const xs = anchors.map(a => a.x), ys = anchors.map(a => a.y);
    const span = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
    score += span;
    score += Math.max(0, anchors.length - 1) * 160;
    score += busSpreadPenalty(anchors) * 40;
  }
  score += estimatedRoutabilityPenalty();
  score += state.rats.length * 10000;
  return score;
}

/**
 * Cheap routability estimate: penalise layouts where a net's anchor buses
 * are separated by a densely-occupied column band.  Runs in O(nets × span × rows)
 * which is fast enough for 900 SA iterations.
 */
function estimatedRoutabilityPenalty() {
  const rows = boardConfig().rows;
  let penalty = 0;
  for (const net of state.activeNets) {
    const anchors = oneAnchorPerBus(state.netAnchors.get(net) || []);
    if (anchors.length < 2) continue;
    for (const [a, b] of minimumSpanningTree(anchors)) {
      if (a.bus === b.bus) continue;
      const minCol = Math.min(a.col, b.col);
      const maxCol = Math.max(a.col, b.col);
      const colSpan = maxCol - minCol;
      if (colSpan === 0) continue;
      let occupied = 0, total = 0;
      for (let c = minCol; c <= maxCol; c++) {
        for (const row of rows) {
          const hole = holeAt(c, row);
          if (!hole) continue;
          total++;
          if (hole.occupiedBy) occupied++;
        }
      }
      const congestion = total > 0 ? occupied / total : 0;
      penalty += congestion * colSpan * 60;
    }
  }
  return penalty;
}

function busSpreadPenalty(anchors) {
  const groups = new Set(anchors.map(a => a.group));
  const cols = anchors.map(a => a.col);
  return groups.size * 2 + (Math.max(...cols) - Math.min(...cols)) * 0.15;
}

function wireCrossingCount() {
  const wires = state.wires.map(w => ({ net: w.net, segments: segmentsForPoints(w.points) }));
  let count = 0;
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      if (wires[i].net === wires[j].net) continue;
      for (const a of wires[i].segments) {
        for (const b of wires[j].segments) {
          if (segmentsShareEndpoint(a, b)) continue;
          if (segmentsCross(a, b)) count++;
        }
      }
    }
  }
  return count;
}

function overlapCount() {
  let count = 0;
  const placed = state.placedBoardParts;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (rectsOverlap(rect(placed[i].x, placed[i].y, placed[i].w, placed[i].h),
                       rect(placed[j].x, placed[j].y, placed[j].w, placed[j].h), 6)) count++;
    }
  }
  return count;
}

// ─── Plan and optimize ────────────────────────────────────────────────────────

function clearPlan() {
  state.wires = [];
  state.rats = [];
  state.routeSegments = [];
  state.usedBuses.clear();
  state.netAnchors.clear();
  state.peripheralLanes.clear();
  state.resetBoardPlacement();
}

function buildInitialPlan({ emitLog = false } = {}) {
  clearPlan();
  const ordered = [...state.boardParts]
    .sort((a, b) => netDegree(b) - netDegree(a) || b.pins.length - a.pins.length);
  for (const part of ordered) {
    const candidates = generateCandidates(part);
    if (!candidates.length) {
      if (emitLog) log(`place ${part.id}: failed, no legal candidates`);
      continue;
    }
    const best = candidates.toSorted((a, b) => scorePlacement(part, a) - scorePlacement(part, b))[0];
    applyPlacement(part, best);
    if (emitLog) log(`place ${part.id}: ${best.strategy} holes=${best.holes.map(h => h.id).join(",")}`);
  }
  allocatePeripheralAnchors(emitLog);
  routeAllNets(emitLog);
  computeMetrics();
}

function annealingCandidate(part, candidates, temperature) {
  if (!candidates.length) return null;
  const ranked = candidates
    .map(c => ({ candidate: c, score: scorePlacement(part, c) }))
    .toSorted((a, b) => a.score - b.score);
  const breadth = Math.max(1, Math.min(ranked.length, Math.floor(4 + temperature / 14)));
  return ranked[Math.floor(Math.random() * breadth)].candidate;
}

function optimize({ iterations = 900, routingRefinement = true } = {}) {
  if (!state.placedBoardParts.length) {
    buildInitialPlan({ emitLog: false });
  }
  allocatePeripheralAnchors();
  let current = estimatedPlacementObjective();
  let best = current;
  let bestLayout = snapshotLayout();
  let accepted = 0, improved = 0;
  const boardParts = state.placedBoardParts;

  // Phase 1: simulated annealing with cheap estimated objective
  _silent = true;
  for (let i = 0; i < iterations; i++) {
    const temperature = 420 * Math.pow(0.006, i / iterations);
    const beforeLayout = snapshotLayout();
    const part = boardParts[Math.floor(Math.random() * boardParts.length)];
    releasePart(part);
    const candidates = generateCandidates(part);
    const candidate = annealingCandidate(part, candidates, temperature);
    if (candidate) applyPlacement(part, candidate);
    allocatePeripheralAnchors();
    const next = estimatedPlacementObjective();
    const delta = next - current;
    const accept = delta <= 0 || Math.random() < Math.exp(-delta / Math.max(temperature, 0.001));
    if (accept && candidate) {
      current = next;
      accepted++;
      if (next < best) { best = next; bestLayout = snapshotLayout(); improved++; }
    } else {
      restoreLayout(beforeLayout);
    }
  }
  _silent = false;

  // Phase 2: routing-aware refinement if any nets still unrouted
  restoreLayout(bestLayout);
  allocatePeripheralAnchors();
  routeAllNets(false);

  if (routingRefinement && state.rats.length > 0) {
    // Use a single fast ordering (not the full multi-order attempt) per iteration
    let refineCurrent = totalObjective();
    let refineImproved = 0;
    for (let i = 0; i < 80; i++) {
      const temperature = 60 * Math.pow(0.01, i / 80);
      const beforeLayout = snapshotLayout();
      const part = boardParts[Math.floor(Math.random() * boardParts.length)];
      releasePart(part);
      const candidates = generateCandidates(part);
      const candidate = annealingCandidate(part, candidates, temperature);
      if (candidate) applyPlacement(part, candidate);
      allocatePeripheralAnchors();
      // Route with a single ordering for speed during refinement
      resetDetailedRouteAttempt();
      for (const net of state.activeNets) routeOneNet(net);
      findUnresolvedNets();
      computeMetrics();
      const next = totalObjective();
      const delta = next - refineCurrent;
      const accept = delta <= 0 || Math.random() < Math.exp(-delta / Math.max(temperature, 0.001));
      if (accept && candidate) {
        refineCurrent = next;
        if (next < best) {
          best = next;
          bestLayout = snapshotLayout();
          refineImproved++;
        }
      } else {
        restoreLayout(beforeLayout);
      }
    }
    log(`optimize: routing-refinement improvements=${refineImproved}`);
  }

  restoreLayout(bestLayout);
  allocatePeripheralAnchors();
  routeAllNets(true);
  computeMetrics();
  log(`optimize: sa iterations=${iterations} accepted=${accepted} improvements=${improved} objective=${Math.round(totalObjective())}`);
}

// ─── Solution extraction ──────────────────────────────────────────────────────

function extractSolution() {
  return {
    ok: state.rats.length === 0 && state.validation.filter(v => v.status === "fail").length === 0,
    metrics: { ...state.metrics },
    placement: state.parts.map(part => ({
      id: part.id,
      role: part.role,
      family: part.family,
      placed: part.placed,
      x: Math.round(part.x),
      y: Math.round(part.y),
      holes: part.holes || [],
      pins: (part.pinPoints || []).map((pp, i) => ({
        pin: part.pins[i] || String(i),
        net: part.nets[i] || null,
        hole: pp.hole || null,
        x: Math.round(pp.x),
        y: Math.round(pp.y)
      }))
    })),
    wires: state.wires.map(w => ({
      net: w.net,
      kind: w.kind,
      points: w.points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
    })),
    validation: state.validation.map(v => ({ ...v })),
    log: state.log.slice(-60)
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * route(problem, options) → solution
 *
 * problem = {
 *   board: {
 *     x: 0, y: 0,                          // canvas origin (0,0 for pure routing)
 *     cols: 30,
 *     rows: ["A","B","C","D","E","F","G","H","I","J"],
 *     midGap: 38,
 *     pad: 34,
 *     holePitch: 28                          // optional, defaults to 28
 *   },
 *   parts: [
 *     // board-placeable part (goes on the breadboard):
 *     { id: "Q1", family: "transistor", role: "board",
 *       pins: ["c","b","e"], nets: ["vcc","in","gnd"],
 *       w: 56, h: 72 },
 *     // two-pin through-hole with bendable leads:
 *     { id: "R1", family: "resistor", role: "board",
 *       pins: ["1","2"], nets: ["vcc","n_q1"],
 *       w: 84, h: 24, bendable: true },
 *     // peripheral part (fixed off-board position):
 *     { id: "V1", family: "power module", role: "peripheral",
 *       pins: ["+","-"], nets: ["vcc","gnd"],
 *       x: 50, y: 80, w: 100, h: 80 }
 *   ]
 * }
 *
 * options = {
 *   iterations:         900,     // SA iterations
 *   seed:               null,    // integer for reproducible runs
 *   routingRefinement:  true     // post-SA routing-aware pass
 * }
 */
export function route(problem, options = {}) {
  const { iterations = 900, seed, routingRefinement = true } = options;
  if (seed !== undefined) seedRandom(seed);
  routerSettings = { ...DEFAULT_ROUTER_SETTINGS, ...(options.settings || {}) };
  if (Number.isFinite(iterations)) routerSettings.iterations = iterations;
  if (Number.isFinite(options.attempts)) routerSettings.attempts = options.attempts;
  routerSettings.maxJumperHoles = Math.max(1, routerSettings.maxJumperHoles);

  state = new RouterState(problem.parts, {
    holePitch: HOLE_PITCH,
    ...problem.board
  });
  for (const part of state.boardParts) part.resetFloatingPosition();
  buildInitialPlan({ emitLog: true });
  optimize({ iterations, routingRefinement });
  return extractSolution();
}

function seedRandom(seed) {
  let s = seed >>> 0;
  Math.random = () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ─── Sample problem (for testing) ────────────────────────────────────────────

export const DEFAULT_BOARD = {
  x: 380, y: 190, cols: 30,
  rows: ["A","B","C","D","E","F","G","H","I","J"],
  midGap: 38, pad: 34, holePitch: 28
};

export const SAMPLE_PARTS = [
  // Derived from F:/docs/Fritzing/fuzz_netlist.xml.
  // Net IDs are the XML net order with breadboard-only buses removed.
  // Q1/Q2 are PNP germanium Fuzz Face transistors. connector0=E, connector1=B, connector2=C.
  { id: "Q1", family: "pnp transistor", role: "board", pins: ["e","b","c"], nets: ["N10","N3","N11"], w: 56, h: 72 },
  { id: "Q2", family: "pnp transistor", role: "board", pins: ["e","b","c"], nets: ["N2","N11","N9"], w: 56, h: 72 },
  { id: "R1", family: "resistor", role: "board", pins: ["0","1"], nets: ["N1","N11"], w: 84, h: 24, bendable: true },
  { id: "R2", family: "resistor", role: "board", pins: ["0","1"], nets: ["N1","N8"], w: 84, h: 24, bendable: true },
  { id: "R3", family: "potentiometer", role: "board", pins: ["leg1","wiper","leg2"], nets: ["N10","N4","N2"], w: 60, h: 60 },
  { id: "R4", family: "resistor", role: "board", pins: ["0","1"], nets: ["N3","N2"], w: 84, h: 24, bendable: true },
  { id: "R6", family: "resistor", role: "board", pins: ["0","1"], nets: ["N8","N9"], w: 84, h: 24, bendable: true },
  { id: "C1", family: "capacitor", role: "board", pins: ["+","-"], nets: ["N5","N3"], w: 42, h: 72, bendable: true },
  { id: "C2", family: "capacitor", role: "board", pins: ["0","1"], nets: ["N8","N6"], w: 42, h: 58, bendable: true },
  { id: "C3", family: "capacitor", role: "board", pins: ["+","-"], nets: ["N10","N4"], w: 42, h: 72, bendable: true },
  { id: "U1", family: "audio jack", role: "peripheral", pins: ["sleeve","right"], nets: ["N10","N7"], x: 1390, y: 86, w: 90, h: 96 },
  { id: "U2", family: "audio jack", role: "peripheral", pins: ["sleeve","right"], nets: ["N10","N5"], x: 95, y: 470, w: 90, h: 96 },
  { id: "R5", family: "panel potentiometer", role: "peripheral", pins: ["leg1","wiper","leg2"], nets: ["N10","N7","N6"], x: 1375, y: 310, w: 105, h: 86 },
  // V1 is absent from the XML netlist. This PNP Fuzz Face is positive-ground:
  // battery + goes to common N10, battery - goes to the R1/R2 supply rail N1.
  { id: "V1", family: "power module", role: "peripheral", pins: ["+","-"], nets: ["N10","N1"], x: 115, y: 80, w: 100, h: 80 }
];
