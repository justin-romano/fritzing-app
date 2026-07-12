(() => {
  const svg = document.getElementById("scene");
  const logEl = document.getElementById("log");
  const metricsEl = document.getElementById("metrics");
  const validationEl = document.getElementById("validation");
  const settingsEl = document.getElementById("routerSettings");

  const NS = "http://www.w3.org/2000/svg";
  const holePitch = 28;
  const defaultRouterSettings = Object.freeze({
    attempts: 3,
    iterations: 360,
    maxJumperHoles: 10,
    jumperPenalty: 240,
    crossingPenalty: 700,
    overlapPenalty: 1200,
    objectiveJumperPenalty: 180,
    objectiveCrossingPenalty: 450
  });
  let routerSettings = { ...defaultRouterSettings };
  const board = {
    x: 380,
    y: 190,
    cols: 30,
    rows: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
    midGap: 38,
    pad: 34
  };

  class CircuitDefinition {
    #boardSpec;
    #partSpecs;
    #netSpecs;

    constructor({ board, parts, nets = [] }) {
      this.#boardSpec = structuredClone(board);
      this.#partSpecs = structuredClone(parts);
      this.#netSpecs = structuredClone(nets);
    }

    get boardSpec() {
      return structuredClone(this.#boardSpec);
    }

    get partSpecs() {
      return structuredClone(this.#partSpecs);
    }

    get netSpecs() {
      return structuredClone(this.#netSpecs);
    }

    createState() {
      const state = new RouterState(this.partSpecs, this.boardSpec, this.netSpecs);
      state.modelValidation = this.validateState(state);
      return state;
    }

    validateState(state) {
      const expected = new Map();
      for (const net of this.#netSpecs) {
        for (const connector of net.connectors) {
          if (connector.synthetic) continue;
          expected.set(`${connector.part}.${connector.connectorId}`, net.id);
        }
      }

      const rendered = new Map();
      const failures = [];
      for (const part of state.parts) {
        for (const pin of part.connectors) {
          if (pin.synthetic) continue;
          const key = `${part.id}.${pin.id}`;
          rendered.set(key, pin.net);
          const expectedNet = expected.get(key);
          if (!expectedNet) {
            failures.push({ status: "fail", net: key, reason: "graphical connector is not present in XML netlist" });
          } else if (expectedNet !== pin.net) {
            failures.push({ status: "fail", net: key, reason: `graphical net ${pin.net} does not match XML net ${expectedNet}` });
          }
        }
      }

      for (const [key, expectedNet] of expected) {
        if (!rendered.has(key)) {
          failures.push({ status: "fail", net: key, reason: `XML connector on ${expectedNet} is missing from graphical model` });
        }
      }

      if (failures.length) return failures;
      return [{ status: "ok", net: "model", reason: `${expected.size} XML connectors represented by graphical pins` }];
    }
  }

  class ModelObject {
    constructor(spec) {
      const { id, role, family, pins, nets, connectorIds, ...rest } = structuredClone(spec);
      this.id = id;
      this.role = role;
      this.family = family;
      Object.assign(this, rest);
    }
  }

  class PinModel {
    constructor({ id, name, net, index, synthetic = false }) {
      this.id = id;
      this.name = name;
      this.net = net;
      this.index = index;
      this.synthetic = synthetic;
    }

    get isConnected() {
      return Boolean(this.net && !this.net.startsWith("unused"));
    }
  }

  const xmlCircuitNets = [
    { id: "N1", connectors: [
      { part: "R2", connectorId: "connector0", name: "Pin 0" },
      { part: "R1", connectorId: "connector0", name: "Pin 0" }
    ] },
    { id: "N2", connectors: [
      { part: "R3", connectorId: "connector2", name: "leg2" },
      { part: "Q2", connectorId: "connector0", name: "E" },
      { part: "R4", connectorId: "connector1", name: "Pin 1" }
    ] },
    { id: "N3", connectors: [
      { part: "Q1", connectorId: "connector1", name: "B" },
      { part: "C1", connectorId: "connector0", name: "-" },
      { part: "R4", connectorId: "connector0", name: "Pin 0" }
    ] },
    { id: "N4", connectors: [
      { part: "C3", connectorId: "connector0", name: "-" },
      { part: "R3", connectorId: "connector1", name: "wiper" }
    ] },
    { id: "N5", connectors: [
      { part: "U2", connectorId: "connector3", name: "RIGHT" },
      { part: "C1", connectorId: "connector1", name: "+" }
    ] },
    { id: "N6", connectors: [
      { part: "C2", connectorId: "connector1", name: "1" },
      { part: "R5", connectorId: "connector2", name: "leg2" }
    ] },
    { id: "N7", connectors: [
      { part: "R5", connectorId: "connector1", name: "wiper" },
      { part: "U1", connectorId: "connector3", name: "RIGHT" }
    ] },
    { id: "N8", connectors: [
      { part: "C2", connectorId: "connector0", name: "0" },
      { part: "R6", connectorId: "connector0", name: "Pin 0" },
      { part: "R2", connectorId: "connector1", name: "Pin 1" }
    ] },
    { id: "N9", connectors: [
      { part: "R6", connectorId: "connector1", name: "Pin 1" },
      { part: "Q2", connectorId: "connector2", name: "C" }
    ] },
    { id: "N10", connectors: [
      { part: "R3", connectorId: "connector0", name: "leg1" },
      { part: "U2", connectorId: "connector0", name: "SLEEVE" },
      { part: "U1", connectorId: "connector0", name: "SLEEVE" },
      { part: "C3", connectorId: "connector1", name: "+" },
      { part: "Q1", connectorId: "connector0", name: "E" },
      { part: "R5", connectorId: "connector0", name: "leg1" }
    ] },
    { id: "N11", connectors: [
      { part: "R1", connectorId: "connector1", name: "Pin 1" },
      { part: "Q2", connectorId: "connector1", name: "B" },
      { part: "Q1", connectorId: "connector2", name: "C" }
    ] }
  ];

  const syntheticCircuitNets = [
    { id: "N1", connectors: [{ part: "V1", connectorId: "connector1", name: "-", synthetic: true }] },
    { id: "N10", connectors: [{ part: "V1", connectorId: "connector0", name: "+", synthetic: true }] }
  ];

  // sampleParts — derived from F:/docs/Fritzing/fuzz_netlist.xml.
  // Net IDs below are the XML net order with breadboard-only buses removed.
  // Q1/Q2 are PNP germanium Fuzz Face transistors. connector0=E, connector1=B, connector2=C.
  const sampleParts = [
    // Q1: PNP transistor. E=N10, B=N3, C=N11.
    { id: "Q1", family: "pnp transistor", role: "board", pins: ["e", "b", "c"], connectorIds: ["connector0", "connector1", "connector2"], nets: ["N10", "N3", "N11"], w: 56, h: 72 },
    // Q2: PNP transistor. E=N2, B=N11, C=N9.
    { id: "Q2", family: "pnp transistor", role: "board", pins: ["e", "b", "c"], connectorIds: ["connector0", "connector1", "connector2"], nets: ["N2", "N11", "N9"], w: 56, h: 72 },
    // R1: 33k resistor, N1 to N11.
    { id: "R1", family: "resistor", role: "board", pins: ["0", "1"], connectorIds: ["connector0", "connector1"], nets: ["N1", "N11"], w: 84, h: 24, bendable: true },
    // R2: 470R resistor, N1 to N8.
    { id: "R2", family: "resistor", role: "board", pins: ["0", "1"], connectorIds: ["connector0", "connector1"], nets: ["N1", "N8"], w: 84, h: 24, bendable: true },
    // R3: fuzz pot, board-mounted. leg1=N10, wiper=N4, leg2=N2.
    { id: "R3", family: "potentiometer", role: "board", pins: ["leg1", "wiper", "leg2"], connectorIds: ["connector0", "connector1", "connector2"], nets: ["N10", "N4", "N2"], w: 60, h: 60 },
    // R4: 100k resistor, N3 to N2.
    { id: "R4", family: "resistor", role: "board", pins: ["0", "1"], connectorIds: ["connector0", "connector1"], nets: ["N3", "N2"], w: 84, h: 24, bendable: true },
    // R6: 8.2k resistor, N8 to N9.
    { id: "R6", family: "resistor", role: "board", pins: ["0", "1"], connectorIds: ["connector0", "connector1"], nets: ["N8", "N9"], w: 84, h: 24, bendable: true },
    // C1: 2.2uF input coupling cap. +=N5, -=N3.
    { id: "C1", family: "capacitor", role: "board", pins: ["+", "-"], connectorIds: ["connector1", "connector0"], nets: ["N5", "N3"], w: 42, h: 72, bendable: true },
    // C2: 10nF cap, N8 to N6.
    { id: "C2", family: "capacitor", role: "board", pins: ["0", "1"], connectorIds: ["connector0", "connector1"], nets: ["N8", "N6"], w: 42, h: 58, bendable: true },
    // C3: 22uF cap. +=N10, -=N4.
    { id: "C3", family: "capacitor", role: "board", pins: ["+", "-"], connectorIds: ["connector1", "connector0"], nets: ["N10", "N4"], w: 42, h: 72, bendable: true },
    // U1: output audio jack (peripheral)
    { id: "U1", family: "audio jack", role: "peripheral", pins: ["sleeve", "right"], connectorIds: ["connector0", "connector3"], nets: ["N10", "N7"], x: 1390, y: 86, w: 90, h: 96 },
    // U2: input audio jack (peripheral)
    { id: "U2", family: "audio jack", role: "peripheral", pins: ["sleeve", "right"], connectorIds: ["connector0", "connector3"], nets: ["N10", "N5"], x: 95, y: 470, w: 90, h: 96 },
    // R5: output volume pot (peripheral)
    { id: "R5", family: "panel potentiometer", role: "peripheral", pins: ["leg1", "wiper", "leg2"], connectorIds: ["connector0", "connector1", "connector2"], nets: ["N10", "N7", "N6"], x: 1375, y: 310, w: 105, h: 86 },
    // V1 is absent from the XML netlist. This PNP Fuzz Face is positive-ground:
    // battery + goes to common N10, battery - goes to the R1/R2 supply rail N1.
    { id: "V1", family: "power module", role: "peripheral", pins: ["+", "-"], connectorIds: ["connector0", "connector1"], syntheticPins: [true, true], nets: ["N10", "N1"], x: 115, y: 80, w: 100, h: 80 }
  ];

  class BreadboardModel {
    #byId;
    #byRowCol;

    constructor(config) {
      this.config = structuredClone(config);
      this.holes = this.#createHoles();
      this.#byId = new Map(this.holes.map(hole => [hole.id, hole]));
      this.#byRowCol = new Map(this.holes.map(hole => [`${hole.row}:${hole.col}`, hole]));
    }

    get center() {
      return {
        x: this.config.x + this.config.pad + ((this.config.cols - 1) * holePitch) / 2,
        y: this.config.y + this.config.pad + ((this.config.rows.length - 1) * holePitch + this.config.midGap) / 2
      };
    }

    get rect() {
      return rect(
        this.config.x,
        this.config.y,
        this.config.pad * 2 + (this.config.cols - 1) * holePitch,
        this.config.pad * 2 + (this.config.rows.length - 1) * holePitch + this.config.midGap
      );
    }

    edgeX(side) {
      return side === "left"
        ? this.config.x
        : this.config.x + this.config.pad * 2 + (this.config.cols - 1) * holePitch;
    }

    freeHoles() {
      return this.holes.filter(hole => !hole.occupiedBy);
    }

    holeAt(col, row) {
      return this.#byRowCol.get(`${row}:${col}`) || null;
    }

    holeById(id) {
      return this.#byId.get(id) || null;
    }

    clearOccupancy() {
      for (const hole of this.holes) hole.occupiedBy = null;
    }

    #createHoles() {
      const holes = [];
      const topRows = 5;
      for (let c = 0; c < this.config.cols; c += 1) {
        for (let r = 0; r < this.config.rows.length; r += 1) {
          const group = r < topRows ? "top" : "bottom";
          const yGap = r < topRows ? 0 : this.config.midGap;
          holes.push({
            id: `${this.config.rows[r]}${c + 1}`,
            row: this.config.rows[r],
            col: c + 1,
            group,
            bus: `${group}:${c + 1}`,
            x: this.config.x + this.config.pad + c * holePitch,
            y: this.config.y + this.config.pad + r * holePitch + yGap,
            occupiedBy: null
          });
        }
      }
      return holes;
    }
  }

  class PartModel extends ModelObject {
    #pins;

    static fromSpec(spec) {
      if (spec.role === "board") return new BoardPartModel(spec);
      if (spec.role === "peripheral") return new PeripheralPartModel(spec);
      return new PartModel(spec);
    }

    constructor(spec) {
      super(spec);
      this.#pins = this.#buildPins(spec);
      this.placed = false;
      this.holes = [];
      this.pinPoints = null;
    }

    get pins() {
      return this.#pins.map(pin => pin.name);
    }

    get nets() {
      return this.#pins.map(pin => pin.net);
    }

    get connectors() {
      return this.#pins;
    }

    get isBoardPlaceable() {
      return false;
    }

    get isPeripheral() {
      return false;
    }

    get activeNets() {
      return this.#pins.filter(pin => pin.isConnected).map(pin => pin.net);
    }

    pinAt(index) {
      return this.#pins[index] || null;
    }

    resetFloatingPosition() {
      if (!this.isBoardPlaceable) return;
      this.x = 105 + Math.random() * 240;
      this.y = 140 + Math.random() * 480;
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

    #buildPins(spec) {
      return spec.pins.map((name, index) => new PinModel({
        id: spec.connectorIds?.[index] || `connector${index}`,
        name,
        net: spec.nets[index] || null,
        index,
        synthetic: Boolean(spec.syntheticPins?.[index])
      }));
    }
  }

  class BoardPartModel extends PartModel {
    get isBoardPlaceable() {
      return true;
    }
  }

  class PeripheralPartModel extends PartModel {
    get isPeripheral() {
      return true;
    }
  }

  class WirePath {
    constructor(net, points, kind) {
      this.net = net;
      this.points = points;
      this.kind = kind;
    }

    get segments() {
      return segmentsForPoints(this.points);
    }

    get length() {
      let total = 0;
      for (let i = 1; i < this.points.length; i += 1) {
        total += manhattan(this.points[i - 1], this.points[i]);
      }
      return total;
    }
  }

  class SvgSceneRenderer {
    #svg;
    #boardSpec;

    constructor(svg, boardSpec) {
      this.#svg = svg;
      this.#boardSpec = boardSpec;
    }

    render(state) {
      this.#svg.replaceChildren();
      this.#renderBoard(state);
      this.#renderWires(state);
      this.#renderParts(state);
      this.#renderRats(state);
    }

    #renderBoard(state) {
      const width = this.#boardSpec.pad * 2 + (this.#boardSpec.cols - 1) * holePitch;
      const height = this.#boardSpec.pad * 2 + (this.#boardSpec.rows.length - 1) * holePitch + this.#boardSpec.midGap;
      this.#append("rect", { class: "board-body", x: this.#boardSpec.x, y: this.#boardSpec.y, width, height, rx: 4 });

      const occupiedBuses = new Set();
      for (const hole of state.holes) {
        if (hole.occupiedBy) occupiedBuses.add(hole.bus);
      }

      for (const hole of state.holes) {
        let cls = "hole";
        if (hole.occupiedBy) cls += " used";
        else if (occupiedBuses.has(hole.bus)) cls += " connected";
        this.#append("circle", { class: cls, cx: hole.x, cy: hole.y, r: 6 });
      }
    }

    #renderWires(state) {
      for (const wire of state.wires) {
        this.#append("path", { class: "wire-path", d: pathData(wire.points), "data-net": wire.net, "data-kind": wire.kind });
      }
    }

    #renderParts(state) {
      for (const part of state.boardParts) {
        this.#renderFootprintLeads(part);
      }

      for (const part of state.parts) {
        const cls = part.isPeripheral ? "part-peripheral" : "part-board";
        this.#append("rect", { class: `part-body ${cls}`, x: part.x, y: part.y, width: part.w, height: part.h, rx: 7, "data-part": part.id });
        this.#append("text", { class: "part-label", x: part.x + part.w / 2, y: part.y + part.h / 2 }, part.id);
      }

      for (const part of state.boardParts) {
        this.#renderHoleContacts(part);
      }

      for (const part of state.parts) {
        this.#renderBodyPins(part);
      }
    }

    #renderFootprintLeads(part) {
      const holePins = part.pinPoints || [];
      const bodyPins = bodyPinPoints(part, holePins);
      for (let i = 0; i < Math.min(bodyPins.length, holePins.length); i += 1) {
        const bodyPin = bodyPins[i];
        const holePin = holePins[i];
        if (manhattan(bodyPin, holePin) < 2) continue;
        this.#append("path", {
          class: "footprint-lead",
          d: pathData([bodyPin, holePin]),
          "data-part": part.id,
          "data-pin": part.pinAt(i)?.name || i,
          "data-connector": part.pinAt(i)?.id || "",
          "data-net": part.pinAt(i)?.net || "",
          "data-hole": holePin.hole || holePin.holeId || ""
        });
      }
    }

    #renderHoleContacts(part) {
      const holePins = part.pinPoints || [];
      for (let i = 0; i < holePins.length; i += 1) {
        const pin = part.pinAt(i);
        const holePin = holePins[i];
        const contact = this.#append("circle", {
          class: "hole-contact",
          cx: holePin.x,
          cy: holePin.y,
          r: 7,
          "data-part": part.id,
          "data-pin": pin?.name || i,
          "data-connector": pin?.id || "",
          "data-net": pin?.net || "",
          "data-hole": holePin.hole || holePin.holeId || ""
        });
        this.#appendTitle(contact, `${part.id}.${pin?.id || i} ${pin?.name || ""} ${pin?.net || ""} ${holePin.hole || holePin.holeId || ""}`.trim());
      }
    }

    #renderBodyPins(part) {
      const pins = part.isPeripheral ? pinPointsForPeripheral(part) : bodyPinPoints(part, part.pinPoints || []);
      pins.forEach((point, index) => {
        const pin = part.pinAt(index);
        const bodyPin = this.#append("circle", {
          class: "pin body-pin",
          cx: point.x,
          cy: point.y,
          r: 5,
          "data-part": part.id,
          "data-pin": pin?.name || index,
          "data-connector": pin?.id || "",
          "data-net": pin?.net || ""
        });
        this.#appendTitle(bodyPin, `${part.id}.${pin?.id || index} ${pin?.name || ""} ${pin?.net || ""}`.trim());
      });
    }

    #renderRats(state) {
      for (const rat of state.rats) {
        this.#append("path", { class: "ratline", d: pathData([rat.a, rat.b]) });
      }
    }

    #append(tag, attrs, text) {
      const el = document.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
      }
      if (text) el.textContent = text;
      this.#svg.appendChild(el);
      return el;
    }

    #appendTitle(parent, text) {
      if (!text) return;
      const title = document.createElementNS(NS, "title");
      title.textContent = text;
      parent.appendChild(title);
    }
  }

  class PanelRenderer {
    #metricsEl;
    #validationEl;
    #logEl;

    constructor({ metricsEl, validationEl, logEl }) {
      this.#metricsEl = metricsEl;
      this.#validationEl = validationEl;
      this.#logEl = logEl;
    }

    render(state) {
      this.#renderMetrics(state);
      this.#renderValidation(state);
    }

    writeLog(lines) {
      this.#logEl.textContent = lines.slice(-80).join("\n");
      this.#logEl.scrollTop = this.#logEl.scrollHeight;
    }

    #renderMetrics(state) {
      this.#metricsEl.replaceChildren();
      for (const [key, value] of Object.entries(state.metrics)) {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = key;
        dd.textContent = value;
        this.#metricsEl.append(dt, dd);
      }
    }

    #renderValidation(state) {
      const entries = [
        ...(state.modelValidation || []),
        ...state.validation
      ];
      this.#validationEl.textContent = entries
        .map(entry => {
          const anchors = entry.anchors ? ` [${entry.anchors.join(", ")}]` : "";
          return `${entry.status.toUpperCase()}  ${entry.net}: ${entry.reason}${anchors}`;
        })
        .join("\n");
    }
  }

  class RouterView {
    #scene;
    #panels;

    constructor({ svg, metricsEl, validationEl, logEl, boardSpec }) {
      this.#scene = new SvgSceneRenderer(svg, boardSpec);
      this.#panels = new PanelRenderer({ metricsEl, validationEl, logEl });
    }

    render(state) {
      this.#scene.render(state);
      this.#panels.render(state);
    }

    log(state, message) {
      const line = `${new Date().toLocaleTimeString()}  ${message}`;
      state.log.push(line);
      this.#panels.writeLog(state.log);
    }
  }

  class RouterState {
    #partById;
    #partsByNet;

    constructor(partSpecs, boardSpec) {
      this.boardModel = new BreadboardModel(boardSpec);
      this.parts = partSpecs.map(PartModel.fromSpec);
      this.#partById = new Map(this.parts.map(part => [part.id, part]));
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
      this.modelValidation = [];
      this.placementMode = "route";
      this.silent = false;
      this.log = [];
      this.metrics = {};
    }

    get holes() {
      return this.boardModel.holes;
    }

    get boardParts() {
      return this.parts.filter(part => part.isBoardPlaceable);
    }

    get placedBoardParts() {
      return this.boardParts.filter(part => part.placed);
    }

    get peripheralParts() {
      return this.parts.filter(part => part.isPeripheral);
    }

    get activeNets() {
      return [...this.#partsByNet.keys()];
    }

    findPart(id) {
      return this.#partById.get(id) || null;
    }

    partsForNet(net) {
      return this.#partsByNet.get(net) || [];
    }

    clearRouteData() {
      this.wires = [];
      this.rats = [];
      this.routeSegments = [];
      this.busGraph = null;
      this.validation = [];
    }

    clearConnectivity() {
      this.usedBuses.clear();
      this.netAnchors.clear();
      this.peripheralLanes.clear();
    }

    resetBoardPlacement() {
      this.boardModel.clearOccupancy();
      this.busGraph = null;
      for (const part of this.boardParts) part.releasePlacement();
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
      const maxLength = holePitch * routerSettings.maxJumperHoles;

      // Build the expensive bus-pair/hole-pair candidate list once per route
      // attempt.  Dynamic penalties are applied later, during Dijkstra.
      for (let i = 0; i < busList.length; i += 1) {
        for (let j = i + 1; j < busList.length; j += 1) {
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
          const baseCost = length + routerSettings.jumperPenalty;
          candidates.push({ from: fromBus, to: toBus, fromHole, toHole, baseCost });
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

  const sampleCircuit = new CircuitDefinition({
    board,
    parts: sampleParts,
    nets: [...xmlCircuitNets, ...syntheticCircuitNets]
  });
  const view = new RouterView({ svg, metricsEl, validationEl, logEl, boardSpec: board });
  let state;

  function reset() {
    state = sampleCircuit.createState();
    for (const part of state.boardParts) part.resetFloatingPosition();
    render();
    log("reset: sample fuzz-style amplifier loaded");
  }

  function plan() {
    state.placementMode = "route";
    buildInitialPlan({ paint: true, emitLog: true });
  }

  function buildInitialPlan({ paint, emitLog }) {
    clearPlan();
    placeBoardParts({ emitLog });
    allocatePeripheralAnchors();
    routeAllNets(emitLog);
    computeMetrics();
    if (paint) render();
  }

  function placeOnly() {
    state.placementMode = "place";
    clearPlan();
    placeBoardParts({ emitLog: true });
    state.clearRouteData();
    state.clearConnectivity();
    rebuildAnchors();
    validatePhysicalPlacement();
    computeMetrics();
    render();
    log("place: board parts placed with circuit nets ignored; peripherals left fixed");
  }

  function placeBoardParts({ emitLog }) {
    const ordered = [...state.boardParts]
      .sort((a, b) =>
        netDegree(b) - netDegree(a)
        || b.pins.length - a.pins.length
        || (b.w * b.h) - (a.w * a.h)
      );

    for (const part of ordered) {
      const candidates = generateCandidates(part);
      if (!candidates.length) {
        if (emitLog) log(`place ${part.id}: failed, no legal candidates`);
        continue;
      }
      const best = candidates.toSorted((a, b) => scorePlacement(part, a) - scorePlacement(part, b))[0];
      applyPlacement(part, best);
      if (emitLog) log(`place ${part.id}: ${best.strategy} score=${scorePlacement(part, best).toFixed(1)} holes=${best.holes.map(h => h.id).join(",")}`);
    }
  }

  function optimize() {
    state.placementMode = "route";
    syncRouterSettings();
    const attempts = routerSettings.attempts;
    const iterations = routerSettings.iterations;
    let bestScore = Infinity;
    let bestLayout = null;
    let bestAttempt = 0;
    let acceptedTotal = 0;
    let improvedTotal = 0;
    state.silent = true;

    // Multi-start annealing: each attempt begins from a fresh greedy placement,
    // then explores local moves.  The cheap placement estimate guides each
    // attempt, but the winner is chosen by the real routed objective.
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      clearPlan();
      placeBoardParts({ emitLog: false });
      allocatePeripheralAnchors();

      let current = estimatedPlacementObjective();
      let bestEstimate = current;
      let attemptBestLayout = snapshotLayout();
      let accepted = 0;
      let improved = 0;
      const boardParts = state.placedBoardParts;

      for (let i = 0; i < iterations; i += 1) {
        // Exponential cooling: early iterations can accept worse placements to
        // escape local minima; late iterations become mostly greedy.
        const temperature = 460 * Math.pow(0.006, i / iterations);
        const beforeLayout = snapshotLayout();
        const part = boardParts[Math.floor(Math.random() * boardParts.length)];
        releasePart(part);
        const candidates = generateCandidates(part);
        const candidate = annealingCandidate(part, candidates, temperature);
        if (candidate) applyPlacement(part, candidate);

        allocatePeripheralAnchors();
        const next = estimatedPlacementObjective();
        const delta = next - current;
        // Metropolis acceptance rule.  A worse move can survive if the current
        // temperature is still high enough; this is the SA "jostling" step.
        const accept = delta <= 0 || Math.random() < Math.exp(-delta / Math.max(temperature, 0.001));

        if (accept && candidate) {
          current = next;
          accepted += 1;
          if (next < bestEstimate) {
            bestEstimate = next;
            attemptBestLayout = snapshotLayout();
            improved += 1;
          }
        } else {
          restoreLayout(beforeLayout);
        }
      }

      restoreLayout(attemptBestLayout);
      allocatePeripheralAnchors();
      routeAllNets(false);
      const routedScore = totalObjective();
      if (routedScore < bestScore) {
        bestScore = routedScore;
        bestAttempt = attempt;
        bestLayout = snapshotLayout();
      }
      acceptedTotal += accepted;
      improvedTotal += improved;
    }

    if (bestLayout) restoreLayout(bestLayout);
    allocatePeripheralAnchors();
    routeAllNets();
    state.silent = false;
    computeMetrics();
    render();
    log(`optimize: multistart attempts=${attempts} iterations=${iterations} bestAttempt=${bestAttempt} accepted=${acceptedTotal} improvements=${improvedTotal} best=${Math.round(bestScore)} final=${Math.round(totalObjective())}`);
    log(`settings: ${settingsSummary()}`);
  }

  function annealingCandidate(part, candidates, temperature) {
    if (!candidates.length) return null;
    const ranked = candidates
      .map(candidate => ({ candidate, score: scorePlacement(part, candidate) }))
      .toSorted((a, b) => a.score - b.score);
    // High temperature samples from a wider set of plausible placements.  Low
    // temperature collapses toward the best-scoring candidate.
    const breadth = Math.max(1, Math.min(ranked.length, Math.floor(4 + temperature / 14)));
    return ranked[Math.floor(Math.random() * breadth)].candidate;
  }

  function clearPlan() {
    state.wires = [];
    state.rats = [];
    state.routeSegments = [];
    state.usedBuses.clear();
    state.netAnchors.clear();
    state.peripheralLanes.clear();
    state.resetBoardPlacement();
  }

  function netDegree(part) {
    if (state.placementMode === "place") return 0;
    return part.nets.reduce((sum, net) => sum + state.partsForNet(net).length, 0);
  }

  function generateCandidates(part) {
    if (part.pins.length === 2 && part.bendable) {
      return generateTwoPinBendableCandidates(part);
    }
    if (part.pins.length === 3 && (isTransistor(part) || part.family === "potentiometer")) {
      return generateTransistorCandidates(part);
    }
    return generateRigidCandidates(part);
  }

  function isTransistor(part) {
    return part.family.toLowerCase().includes("transistor");
  }

  function generateTwoPinBendableCandidates(part) {
    const candidates = [];
    const busOwners = busNetMap();
    for (const h1 of freeHoles()) {
      // Use a canonical visible passive footprint: leave several holes between
      // the leads instead of allowing cramped real-world placements.
      for (const span of [4, 5, 6, 7, 8]) {
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
    const candidates = [];
    const busOwners = busNetMap();
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
    const candidates = [];
    const busOwners = busNetMap();
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
    const occupiedByThisCandidate = new Set();
    for (let i = 0; i < candidate.holes.length; i += 1) {
      const hole = candidate.holes[i];
      if (occupiedByThisCandidate.has(hole.bus)) return false;
      occupiedByThisCandidate.add(hole.bus);
      const net = placementNet(part, i);
      if (!net || net.startsWith("unused")) continue;
      const existing = busOwners.get(hole.bus);
      if (existing && (existing.size > 1 || !existing.has(net))) return false;
      if (!candidateOwners.has(hole.bus)) candidateOwners.set(hole.bus, new Set());
      candidateOwners.get(hole.bus).add(net);
    }
    return [...candidateOwners.values()].every(nets => nets.size <= 1);
  }

  function scorePlacement(part, candidate) {
    let score = 0;
    candidate.holes.forEach((hole, i) => {
      const net = placementNet(part, i);
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

  function busCongestionPenalty(bus) {
    return state.usedBuses.get(bus)?.length || 0;
  }

  function crossingEstimate(candidate) {
    let crossings = 0;
    for (const hole of candidate.holes) {
      for (const anchors of state.netAnchors.values()) {
        for (const anchor of anchors) {
          if (segmentCrossesBoardCenter(hole, anchor)) crossings += 1;
        }
      }
    }
    return crossings;
  }

  function applyPlacement(part, candidate) {
    part.x = candidate.x;
    part.y = candidate.y;
    part.placed = true;
    part.holes = candidate.holes.map(h => h.id);
    part.pinPoints = candidate.holes.map(h => ({ x: h.x, y: h.y, hole: h.id }));
    candidate.holes.forEach((hole, i) => {
      hole.occupiedBy = `${part.id}:${part.pins[i]}`;
      const net = placementNet(part, i);
      if (net) addNetAnchor(net, hole);
      if (!state.usedBuses.has(hole.bus)) state.usedBuses.set(hole.bus, []);
      state.usedBuses.get(hole.bus).push(part.id);
    });
  }

  function placementNet(part, index) {
    if (state.placementMode === "place") return null;
    return part.nets[index];
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

  function snapshotPart(part) {
    return {
      x: part.x,
      y: part.y,
      placed: part.placed,
      holes: [...(part.holes || [])],
      pinPoints: structuredClone(part.pinPoints)
    };
  }

  function snapshotLayout() {
    return { parts: state.parts.map(part => part.snapshot()) };
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

  function restorePart(part, old) {
    part.x = old.x;
    part.y = old.y;
    part.placed = old.placed;
    part.holes = [...old.holes];
    part.pinPoints = structuredClone(old.pinPoints);
    for (const id of part.holes) {
      const hole = holeById(id);
      if (hole) hole.occupiedBy = part.id;
    }
    rebuildAnchors();
  }

  function rebuildAnchors() {
    state.netAnchors.clear();
    state.usedBuses.clear();
    for (const part of state.placedBoardParts) {
      part.holes.forEach((id, i) => {
        const hole = holeById(id);
        if (!hole) return;
        const net = placementNet(part, i);
        if (net) addNetAnchor(net, hole);
        if (!state.usedBuses.has(hole.bus)) state.usedBuses.set(hole.bus, []);
        state.usedBuses.get(hole.bus).push(part.id);
      });
    }
  }

  function allocatePeripheralAnchors() {
    state.wires = [];
    state.rats = [];
    state.peripheralLanes.clear();
    rebuildAnchors();
    for (const part of peripheralParts()) {
      part.pinPoints = pinPointsForPeripheral(part);
      for (const request of activePeripheralPins(part)) {
        const lane = laneForPeripheralNet(request.net, part, request.pin);
        if (lane) {
          addNetAnchor(request.net, lane);
          state.wires.push(createPeripheralWire(request.net, request.pin, lane, part));
        } else {
          state.rats.push({ net: request.net, a: request.pin, b: boardCenter() });
        }
      }
    }
  }

  function peripheralParts() {
    return state.peripheralParts;
  }

  function activePeripheralPins(part) {
    return part.pinPoints
      .map((pin, i) => ({ pin, net: part.nets[i] }))
      .filter(request => request.net && !request.net.startsWith("unused"));
  }

  function createPeripheralWire(net, pin, lane, part) {
    return new WirePath(net, orthogonal(pin, lane, sideFor(part)), "peripheral");
  }

  function laneForPeripheralNet(net, part, pin) {
    const side = sideFor(part);
    const key = `${net}:${side}`;
    if (state.peripheralLanes.has(key)) return state.peripheralLanes.get(key);
    const lane = allocateLane(net, side, pin);
    if (lane) {
      state.peripheralLanes.set(key, lane);
      if (!state.silent) log(`lane ${net}: allocated ${lane.id} on ${side} edge for off-board terminal`);
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
    const horizontal = Math.abs(hole.x - edge);
    const verticalBias = Math.abs(hole.y - pin.y) * 1.4;
    const owners = busOwners.get(hole.bus);
    const sameNetBonus = owners && owners.size === 1 ? -180 : 0;
    const projected = orthogonal(pin, hole, side);
    return horizontal * 3
      + verticalBias
      + busCongestionPenalty(hole.bus) * 100
      + peripheralWireConflictCost(projected)
      + sameNetBonus;
  }

  function peripheralWireConflictCost(points) {
    if (state.silent) return 0;
    const projectedSegments = segmentsForPoints(points);
    const existingSegments = segmentsForWires(state.wires.filter(wire => wire.kind === "peripheral"));
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

  function boardEdgeX(side) {
    return side === "left" ? board.x : board.x + board.pad * 2 + (board.cols - 1) * holePitch;
  }

  function routeAllNets(emitLog = true) {
    const nets = state.activeNets;
    const attempts = routeOrders(nets).map(order => routeNetsInOrder(order));
    if (globalThis.routerUseGreedy) {
      attempts.push(routeNetsGreedy(nets));
    }
    const best = attempts.toSorted((a, b) => routeAttemptScore(a) - routeAttemptScore(b))[0] || routeNetsInOrder(nets);
    state.wires = best.wires;
    state.rats = best.rats;
    state.routeSegments = best.routeSegments;
    state.validation = best.validation;
    if (emitLog) {
      log(`route: wires=${state.wires.length} unresolved=${state.rats.length} crossings=${wireCrossingCount()}`);
    }
  }

  function routeOrders(nets) {
    const uniqueOrders = [];
    const add = order => {
      const key = order.join("|");
      if (!uniqueOrders.some(existing => existing.key === key)) uniqueOrders.push({ key, order });
    };
    add(nets);
    add([...nets].toSorted((a, b) => routeNetComplexity(a) - routeNetComplexity(b)));
    add([...nets].toSorted((a, b) => routeNetComplexity(b) - routeNetComplexity(a)));
    add([...nets].toSorted((a, b) => routeNetSpan(a) - routeNetSpan(b)));
    add([...nets].toSorted((a, b) => routeNetSpan(b) - routeNetSpan(a)));
    return uniqueOrders.map(entry => entry.order);
  }

  function routeNetComplexity(net) {
    return oneAnchorPerBus(state.netAnchors.get(net) || []).length;
  }

  function routeNetSpan(net) {
    const anchors = oneAnchorPerBus(state.netAnchors.get(net) || []);
    if (anchors.length < 2) return 0;
    const xs = anchors.map(anchor => anchor.x);
    const ys = anchors.map(anchor => anchor.y);
    return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys);
  }

  function routeNetsInOrder(nets) {
    const saved = snapshotRouteState();
    resetDetailedRouteAttempt();
    for (const net of nets) {
      routeOneNet(net);
    }
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

  function resetDetailedRouteAttempt() {
    state.wires = state.wires.filter(w => w.kind === "peripheral");
    state.routeSegments = segmentsForWires(state.wires);
    state.busGraph = new BusGraphCache(state);
    state.rats = [];
    state.validation = [];
    validatePartRoles();
    for (const conflict of busNetConflicts()) {
      state.validation.push({
        net: `bus ${conflict.bus}`,
        status: "fail",
        reason: `same breadboard bus has multiple nets: ${conflict.nets.join(", ")}`,
        anchors: conflict.holes
      });
    }
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
        state.validation.push({ net, status: "fail", reason: `graph route failed ${a.id}->${b.id}`, anchors: busAnchors.map(h => h.id) });
        failed = true;
      }
    }
    if (!failed) {
      state.validation.push({ net, status: "ok", reason: `${busAnchors.length} buses connected`, anchors: busAnchors.map(h => h.id) });
    }
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

  function routeAttemptScore(attempt) {
    const saved = snapshotRouteState();
    restoreRouteState(attempt);
    const score = totalObjective();
    restoreRouteState(saved);
    return score;
  }

  function validatePartRoles() {
    for (const part of state.parts) {
      if (part.isBoardPlaceable) {
        if (!part.placed || !part.holes?.length) {
          state.validation.push({ net: part.id, status: "fail", reason: "board-placeable part is not on the breadboard" });
        }
        if (part.holes?.some(id => !holeById(id))) {
          state.validation.push({ net: part.id, status: "fail", reason: "board-placeable part has invalid breadboard holes", anchors: part.holes });
        }
      }
      if (part.isPeripheral && rectsOverlap(rect(part.x, part.y, part.w, part.h), boardRect(), 0)) {
        state.validation.push({ net: part.id, status: "fail", reason: "peripheral overlaps the breadboard" });
      }
    }
  }

  function validatePhysicalPlacement() {
    state.validation = [];
    const failures = [];
    for (const part of state.boardParts) {
      if (!part.placed || !part.holes?.length) {
        failures.push({ net: part.id, status: "fail", reason: "board-placeable part is not on the breadboard" });
        continue;
      }
      const missing = part.holes.filter(id => !holeById(id));
      if (missing.length) {
        failures.push({ net: part.id, status: "fail", reason: "part references missing breadboard holes", anchors: missing });
      }
      if (part.holes.length !== part.pins.length) {
        failures.push({ net: part.id, status: "fail", reason: `pin count ${part.pins.length} does not match placed holes ${part.holes.length}`, anchors: part.holes });
      }
      const buses = part.holes
        .map(id => holeById(id)?.bus)
        .filter(Boolean);
      if (new Set(buses).size !== buses.length) {
        failures.push({ net: part.id, status: "fail", reason: "multiple pins placed on the same breadboard bus", anchors: part.holes });
      }
    }
    for (const part of state.peripheralParts) {
      if (rectsOverlap(rect(part.x, part.y, part.w, part.h), boardRect(), 0)) {
        failures.push({ net: part.id, status: "fail", reason: "non-placeable peripheral overlaps the breadboard" });
      }
    }
    const overlapsFound = overlapCount();
    if (overlapsFound) {
      failures.push({ net: "placement", status: "fail", reason: `${overlapsFound} part overlaps detected` });
    }
    if (failures.length) {
      state.validation.push(...failures);
    } else {
      state.validation.push({ net: "placement", status: "ok", reason: `${state.placedBoardParts.length} board parts placed without wires` });
    }
  }

  function minimumSpanningTree(points) {
    const edges = [];
    const used = new Set([0]);
    // Prim-style MST over the net's anchor buses.  This approximates a Steiner
    // tree cheaply: connect all terminals with a short tree, then route each
    // selected edge through the breadboard bus graph.
    while (used.size < points.length) {
      let best = null;
      for (const i of used) {
        for (let j = 0; j < points.length; j += 1) {
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
      if (!byBus.has(anchor.bus)) {
        byBus.set(anchor.bus, []);
      }
      byBus.get(anchor.bus).push(anchor);
    }
    // A breadboard bus is already electrically common, so routing to every hole
    // on the same bus would create duplicate work.  Pick one representative.
    return [...byBus.values()].map(group => group.toSorted((a, b) => distanceToBoardCenter(a) - distanceToBoardCenter(b))[0]);
  }

  function busAvailableForNet(bus, net, busOwners = busNetMap()) {
    const owners = busOwners.get(bus);
    return !owners || owners.size === 0 || (owners.size === 1 && owners.has(net));
  }

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
        bus,
        nets: [...byNet.keys()],
        holes: [...byNet.entries()].flatMap(([net, holes]) => holes.map(hole => `${net}:${hole}`))
      });
    }
    return conflicts;
  }

  function routeWireSegmentsBetweenHoles(a, b) {
    if (a.bus === b.bus) return [];
    // Prefer the new bus graph router.  The older point maze remains as a
    // fallback for cases where the bus graph cannot find a legal jumper chain.
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
    return !hole.occupiedBy ||
      sameHole(hole, start) ||
      sameHole(hole, target);
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
      // Dijkstra's algorithm: ignore stale heap entries after a cheaper path to
      // the same bus has already been discovered.
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
        if (!route.length) {
          route = mazeRoute(s, t, start, target, true);
        }
        if (!route.length) continue;
        const fullRoute = [start, ...route, target];
        const cost = routeCost(fullRoute);
        if (!best || cost < best.cost) best = { route: simplifyRoute(fullRoute), cost };
      }
    }
    return best ? best.route : [];
  }

  function accessPointsForHole(hole) {
    const points = [
      hole,
      { x: hole.x, y: hole.y - holePitch },
      { x: hole.x, y: hole.y + holePitch },
      { x: hole.x - holePitch, y: hole.y },
      { x: hole.x + holePitch, y: hole.y }
    ];
    return points.filter(point => routePointInsideSearchArea(point) && !isBlockedRoutePoint(point, hole, hole));
  }

  function routeCost(points) {
    let cost = 0;
    for (let i = 1; i < points.length; i += 1) cost += manhattan(points[i - 1], points[i]);
    // Penalise bends so the fallback maze prefers readable jumper shapes over
    // tiny stair-steps with the same Manhattan length.
    for (let i = 2; i < points.length; i += 1) {
      if (direction(points[i - 2], points[i - 1]) !== direction(points[i - 1], points[i])) cost += 18;
    }
    return cost;
  }

  function mazeRoute(start, target, trueStart, trueTarget, relaxedKeepout) {
    const grid = routingGrid(start, target);
    const startNode = nodeKey(start.x, start.y);
    const targetNode = nodeKey(target.x, target.y);
    const open = new MinHeap((a, b) => a.f - b.f || a.g - b.g);
    open.push({
      key: startNode,
      x: start.x,
      y: start.y,
      g: 0,
      f: manhattan(start, target),
      dir: ""
    });
    const best = new Map([[startNode, 0]]);
    const cameFrom = new Map();

    while (open.size()) {
      const current = open.pop();
      if (current.g !== best.get(current.key)) continue;
      if (current.key === targetNode) {
        return simplifyRoute(reconstructPath(cameFrom, current));
      }

      for (const next of routingNeighbors(current, grid)) {
        if (isBlockedRoutePoint(next, trueStart, trueTarget, relaxedKeepout)) continue;
        if (isBlockedRouteSegment(current, next, trueStart, trueTarget, relaxedKeepout)) continue;
        const dir = direction(current, next);
        const turn = current.dir && current.dir !== dir ? 18 : 0;
        const congestion = congestionPenalty(current, next);
        // A* score: real cost so far + Manhattan heuristic to target.  The
        // congestion term discourages reusing/crossing already-routed jumpers.
        const g = current.g + manhattan(current, next) + turn + congestion;
        if (g >= (best.get(next.key) ?? Infinity)) continue;
        best.set(next.key, g);
        cameFrom.set(next.key, current);
        open.push({
          key: next.key,
          x: next.x,
          y: next.y,
          g,
          f: g + manhattan(next, target),
          dir
        });
      }
    }

    return [];
  }

  function routingGrid(start, target) {
    const xs = unique([
      ...state.holes.map(h => h.x),
      ...state.holes.flatMap(h => [h.x - holePitch, h.x + holePitch]),
      ...state.placedBoardParts.flatMap(p => [p.x - 18, p.x + p.w + 18]),
      board.x - 46,
      board.x + board.pad * 2 + (board.cols - 1) * holePitch + 46,
      start.x,
      target.x
    ]).toSorted((a, b) => a - b);
    const ys = unique([
      ...state.holes.map(h => h.y),
      ...state.holes.map(h => h.y - 18),
      ...state.holes.map(h => h.y + 18),
      ...state.holes.flatMap(h => [h.y - holePitch, h.y + holePitch]),
      ...state.placedBoardParts.flatMap(p => [p.y - 18, p.y + p.h + 18]),
      board.y - 46,
      board.y + board.pad * 2 + (board.rows.length - 1) * holePitch + board.midGap + 46,
      start.y,
      target.y
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

  function pointNode(x, y) {
    return { x, y, key: nodeKey(x, y) };
  }

  function nodeKey(x, y) {
    return `${Math.round(x)},${Math.round(y)}`;
  }

  /**
   * Returns true if the point lies inside the breadboard's physical centre gap
   * (the ridge between the top and bottom strip groups) within the board's
   * horizontal bounds.  Wires must route around this barrier, not through it.
   */
  function isCenterGapPoint(point) {
    const topRows = Math.ceil(board.rows.length / 2);  // 5 for a 10-row board
    const lastTopY    = board.y + board.pad + (topRows - 1) * holePitch;
    const firstBotY   = board.y + board.pad + topRows * holePitch + board.midGap;
    const gapTop      = lastTopY  + holePitch * 0.3;   // just below row E
    const gapBottom   = firstBotY - holePitch * 0.3;   // just above row F
    const boardRight  = board.x + board.pad * 2 + (board.cols - 1) * holePitch;
    return point.x >= board.x && point.x <= boardRight
        && point.y >  gapTop  && point.y <  gapBottom;
  }

  function isBlockedRoutePoint(point, start, target, relaxedKeepout = false) {
    if (samePoint(point, start) || samePoint(point, target)) return false;
    if (!routePointInsideSearchArea(point)) return true;
    return state.placedBoardParts.some(part => {
      const margin = relaxedKeepout ? 2 : 10;
      return pointInRect(point, rect(part.x - margin, part.y - margin, part.w + margin * 2, part.h + margin * 2));
    });
  }

  function isBlockedRouteSegment(a, b, start, target, relaxedKeepout = false) {
    if (samePoint(a, start) || samePoint(a, target) || samePoint(b, start) || samePoint(b, target)) return false;
    return state.placedBoardParts.some(part => {
      const margin = relaxedKeepout ? 2 : 10;
      return segmentIntersectsRect(a, b, rect(part.x - margin, part.y - margin, part.w + margin * 2, part.h + margin * 2));
    });
  }

  function segmentIntersectsRect(a, b, area) {
    if (pointInRect(a, area) || pointInRect(b, area)) return true;
    // Fast paths for orthogonal segments.  Most fallback-maze segments are
    // horizontal or vertical, so avoid the general intersection math there.
    if (a.x === b.x) {
      return a.x >= area.x &&
        a.x <= area.x + area.w &&
        rangesOverlap(a.y, b.y, area.y, area.y + area.h);
    }
    if (a.y === b.y) {
      return a.y >= area.y &&
        a.y <= area.y + area.h &&
        rangesOverlap(a.x, b.x, area.x, area.x + area.w);
    }
    const topLeft = { x: area.x, y: area.y };
    const topRight = { x: area.x + area.w, y: area.y };
    const bottomRight = { x: area.x + area.w, y: area.y + area.h };
    const bottomLeft = { x: area.x, y: area.y + area.h };
    // General line/rectangle collision for graph-router jumper candidates,
    // which may be diagonal.
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
    // Orientation test: sign of the cross product tells whether point c lies to
    // the left or right of directed segment a->b.  Zero means collinear.
    const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
    if (Math.abs(value) < 0.0001) return 0;
    return value > 0 ? 1 : 2;
  }

  function pointOnSegment(point, a, b) {
    return point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) &&
      point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
  }

  function routePointInsideSearchArea(point) {
    const minX = board.x - 70;
    const maxX = board.x + board.pad * 2 + (board.cols - 1) * holePitch + 70;
    const minY = board.y - 70;
    const maxY = board.y + board.pad * 2 + (board.rows.length - 1) * holePitch + board.midGap + 70;
    return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
  }

  function pointInRect(point, area) {
    return point.x >= area.x && point.x <= area.x + area.w && point.y >= area.y && point.y <= area.y + area.h;
  }

  function samePoint(a, b) {
    return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
  }

  function direction(a, b) {
    if (a.x < b.x) return "E";
    if (a.x > b.x) return "W";
    if (a.y < b.y) return "S";
    return "N";
  }

  function congestionPenalty(a, b) {
    let penalty = 0;
    const segment = [a, b];
    for (const existing of state.routeSegments) {
      // Overlap is worse than a crossing because it can visually hide that two
      // different jumpers occupy the same path.
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
    for (let i = 1; i < points.length - 1; i += 1) {
      const prev = simplified[simplified.length - 1];
      const current = points[i];
      const next = points[i + 1];
      if ((prev.x === current.x && current.x === next.x) || (prev.y === current.y && current.y === next.y)) {
        continue;
      }
      simplified.push(current);
    }
    simplified.push(points[points.length - 1]);
    return simplified;
  }

  function segmentsForWires(wires) {
    return wires.flatMap(wire => segmentsForPoints(wire.points));
  }

  function segmentsForPoints(points) {
    const segments = [];
    for (let i = 1; i < points.length; i += 1) {
      segments.push([points[i - 1], points[i]]);
    }
    return segments;
  }

  function segmentsOverlap(a, b) {
    const [a1, a2] = a;
    const [b1, b2] = b;
    if (a1.x === a2.x && b1.x === b2.x && a1.x === b1.x) {
      return rangesOverlap(a1.y, a2.y, b1.y, b2.y);
    }
    if (a1.y === a2.y && b1.y === b2.y && a1.y === b1.y) {
      return rangesOverlap(a1.x, a2.x, b1.x, b2.x);
    }
    return false;
  }

  function segmentsCross(a, b) {
    const [a1, a2] = a;
    const [b1, b2] = b;
    const aVertical = a1.x === a2.x;
    const bVertical = b1.x === b2.x;
    if (aVertical === bVertical) return false;
    const vertical = aVertical ? a : b;
    const horizontal = aVertical ? b : a;
    const [v1, v2] = vertical;
    const [h1, h2] = horizontal;
    return between(v1.x, h1.x, h2.x) && between(h1.y, v1.y, v2.y);
  }

  function rangesOverlap(a1, a2, b1, b2) {
    return Math.max(Math.min(a1, a2), Math.min(b1, b2)) <= Math.min(Math.max(a1, a2), Math.max(b1, b2));
  }

  function between(value, a, b) {
    return value >= Math.min(a, b) && value <= Math.max(a, b);
  }

  function findUnresolvedNets() {
    for (const net of state.activeNets) {
      const pins = [];
      for (const part of state.parts) {
        part.nets.forEach((n, i) => {
          if (n === net) pins.push(pinPoint(part, i));
        });
      }
      const anchors = state.netAnchors.get(net) || [];
      if (pins.length > 1 && anchors.length === 0) {
        state.rats.push({ net, a: pins[0], b: pins[1] });
      }
    }
  }

  function computeMetrics() {
    const wireLength = state.wires.reduce((sum, wire) => {
      for (let i = 1; i < wire.points.length; i += 1) {
        sum += manhattan(wire.points[i - 1], wire.points[i]);
      }
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
      for (let i = 1; i < wire.points.length; i += 1) sum += manhattan(wire.points[i - 1], wire.points[i]);
      return sum;
    }, 0);
    return length + state.wires.length * routerSettings.objectiveJumperPenalty + wireCrossingCount() * routerSettings.objectiveCrossingPenalty + state.rats.length * 10000 + overlapCount() * 2500 + busNetConflicts().length * 50000;
  }

  function estimatedPlacementObjective() {
    let score = overlapCount() * 2500 + busNetConflicts().length * 50000;
    for (const net of state.activeNets) {
      const anchors = oneAnchorPerBus(state.netAnchors.get(net) || []);
      if (anchors.length < 2) continue;
      const xs = anchors.map(a => a.x);
      const ys = anchors.map(a => a.y);
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
   * Penalise layouts where a net's anchor buses are separated by a
   * densely-occupied column band (cheap O(nets × span × rows) proxy for
   * routing difficulty, safe to run on every SA iteration).
   */
  function estimatedRoutabilityPenalty() {
    if (state.silent) return 0;
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
          for (const row of board.rows) {
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

  function onBoard(candidate, part) {
    const minX = board.x + 8;
    const maxX = board.x + board.pad * 2 + (board.cols - 1) * holePitch - part.w + 20;
    const minY = board.y + 8;
    const maxY = board.y + board.pad * 2 + (board.rows.length - 1) * holePitch + board.midGap - part.h + 20;
    return candidate.x >= minX && candidate.x <= maxX && candidate.y >= minY && candidate.y <= maxY;
  }

  function overlaps(candidate, part) {
    const a = footprintRect(part, candidate);
    return state.placedBoardParts.some(other => {
      if (other === part) return false;
      return rectsOverlap(a, footprintRect(other), 10);
    });
  }

  function wireCrossingCount() {
    const wires = state.wires.map(wire => ({ net: wire.net, segments: segmentsForPoints(wire.points) }));
    let count = 0;
    for (let i = 0; i < wires.length; i += 1) {
      for (let j = i + 1; j < wires.length; j += 1) {
        if (wires[i].net === wires[j].net) continue;
        for (const a of wires[i].segments) {
          for (const b of wires[j].segments) {
            if (segmentsShareEndpoint(a, b)) continue;
            if (segmentsCross(a, b)) count += 1;
          }
        }
      }
    }
    return count;
  }

  function segmentsShareEndpoint(a, b) {
    return samePoint(a[0], b[0]) || samePoint(a[0], b[1]) || samePoint(a[1], b[0]) || samePoint(a[1], b[1]);
  }

  function overlapCount() {
    let count = 0;
    const placed = state.placedBoardParts;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        if (rectsOverlap(footprintRect(placed[i]), footprintRect(placed[j]), 10)) {
          count += 1;
        }
      }
    }
    return count;
  }

  function freeHoles() {
    return state.boardModel.freeHoles();
  }

  function holeAt(col, row) {
    return state.boardModel.holeAt(col, row);
  }

  function holeById(id) {
    return state.boardModel.holeById(id);
  }

  function addNetAnchor(net, hole) {
    if (!state.netAnchors.has(net)) state.netAnchors.set(net, []);
    const anchors = state.netAnchors.get(net);
    if (!anchors.some(h => h.id === hole.id)) anchors.push(hole);
  }

  function pinPointsForPeripheral(part) {
    const count = part.pins.length;
    return part.pins.map((pin, i) => ({
      x: part.x + ((i + 1) * part.w) / (count + 1),
      y: part.y + part.h,
      label: `${part.id}:${pin}`
    }));
  }

  function bodyPinPoints(part, holePins = []) {
    if (part.isPeripheral) return pinPointsForPeripheral(part);

    const count = part.pins.length;
    if (!count) return [];
    if (count === 1) return [{ x: part.x + part.w / 2, y: part.y + part.h / 2 }];

    if (count === 2) {
      const [a, b] = holePins;
      const horizontal = !a || !b || Math.abs(a.x - b.x) >= Math.abs(a.y - b.y);
      if (horizontal) {
        return [
          { x: part.x, y: part.y + part.h / 2 },
          { x: part.x + part.w, y: part.y + part.h / 2 }
        ];
      }
      return [
        { x: part.x + part.w / 2, y: part.y },
        { x: part.x + part.w / 2, y: part.y + part.h }
      ];
    }

    if (count === 3) {
      return part.pins.map((pin, i) => ({
        x: part.x + (part.w * (i + 1)) / (count + 1),
        y: part.y + part.h
      }));
    }

    return part.pins.map((pin, i) => {
      const side = i % 2 === 0 ? "left" : "right";
      const lane = Math.floor(i / 2) + 1;
      const lanes = Math.ceil(count / 2) + 1;
      return {
        x: side === "left" ? part.x : part.x + part.w,
        y: part.y + (part.h * lane) / lanes
      };
    });
  }

  function pinPoint(part, i) {
    if (part.pinPoints && part.pinPoints[i]) return part.pinPoints[i];
    if (part.isPeripheral) {
      part.pinPoints = pinPointsForPeripheral(part);
      return part.pinPoints[i];
    }
    return { x: part.x + part.w / 2, y: part.y + part.h / 2 };
  }

  function orthogonal(a, b, side) {
    const offset = side === "left" ? -60 : 60;
    const elbowX = side === "left" ? Math.min(a.x, b.x) + offset : Math.max(a.x, b.x) + offset;
    return [{ x: a.x, y: a.y }, { x: elbowX, y: a.y }, { x: elbowX, y: b.y }, { x: b.x, y: b.y }];
  }

  function sideFor(part) {
    return part.x < board.x ? "left" : "right";
  }

  function nearest(point, points) {
    return points.toSorted((a, b) => manhattan(point, a) - manhattan(point, b))[0];
  }

  function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  function distanceToBoardCenter(point) {
    return manhattan(point, boardCenter());
  }

  function distanceToBoardEdge(point) {
    const left = Math.abs(point.x - board.x);
    const right = Math.abs(point.x - (board.x + board.pad * 2 + (board.cols - 1) * holePitch));
    const top = Math.abs(point.y - board.y);
    const bottom = Math.abs(point.y - (board.y + board.pad * 2 + (board.rows.length - 1) * holePitch + board.midGap));
    return Math.min(left, right, top, bottom);
  }

  function boardCenter() {
    return {
      x: board.x + board.pad + ((board.cols - 1) * holePitch) / 2,
      y: board.y + board.pad + ((board.rows.length - 1) * holePitch + board.midGap) / 2
    };
  }

  function boardRect() {
    return rect(
      board.x,
      board.y,
      board.pad * 2 + (board.cols - 1) * holePitch,
      board.pad * 2 + (board.rows.length - 1) * holePitch + board.midGap
    );
  }

  function segmentCrossesBoardCenter(a, b) {
    const c = boardCenter();
    return Math.abs(((b.y - a.y) * c.x - (b.x - a.x) * c.y + b.x * a.y - b.y * a.x) / Math.max(1, manhattan(a, b))) < 30;
  }

  function rect(x, y, w, h) {
    return { x, y, w, h };
  }

  function rectsOverlap(a, b, margin) {
    return a.x < b.x + b.w + margin &&
      a.x + a.w + margin > b.x &&
      a.y < b.y + b.h + margin &&
      a.y + a.h + margin > b.y;
  }

  function footprintRect(part, candidate = null) {
    const points = [
      { x: candidate?.x ?? part.x, y: candidate?.y ?? part.y },
      { x: (candidate?.x ?? part.x) + part.w, y: candidate?.y ?? part.y },
      { x: (candidate?.x ?? part.x) + part.w, y: (candidate?.y ?? part.y) + part.h },
      { x: candidate?.x ?? part.x, y: (candidate?.y ?? part.y) + part.h }
    ];

    const pins = candidate
      ? candidate.holes.map(hole => ({ x: hole.x, y: hole.y }))
      : (part.pinPoints || []);
    points.push(...pins);

    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const pad = 9;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    return {
      x: minX,
      y: minY,
      w: Math.max(...xs) - minX + pad,
      h: Math.max(...ys) - minY + pad
    };
  }

  function unique(values) {
    return [...new Set(values)];
  }

  class MinHeap {
    constructor(compare) {
      this.compare = compare;
      this.items = [];
    }

    size() {
      return this.items.length;
    }

    push(item) {
      this.items.push(item);
      this.bubbleUp(this.items.length - 1);
    }

    pop() {
      const first = this.items[0];
      const last = this.items.pop();
      if (this.items.length && last) {
        this.items[0] = last;
        this.bubbleDown(0);
      }
      return first;
    }

    bubbleUp(index) {
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (this.compare(this.items[parent], this.items[index]) <= 0) break;
        [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
        index = parent;
      }
    }

    bubbleDown(index) {
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) smallest = left;
        if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) smallest = right;
        if (smallest === index) break;
        [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
        index = smallest;
      }
    }
  }

  function render() {
    view.render(state);
  }

  function pathData(points) {
    return points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  }

  function log(message) {
    view.log(state, message);
  }

  function syncRouterSettings() {
    routerSettings = { ...defaultRouterSettings };
    if (!settingsEl) return routerSettings;
    for (const input of settingsEl.querySelectorAll("[data-setting]")) {
      const key = input.dataset.setting;
      const fallback = defaultRouterSettings[key];
      const value = Number(input.value);
      routerSettings[key] = Number.isFinite(value) ? value : fallback;
    }
    routerSettings.attempts = Math.max(1, Math.round(routerSettings.attempts));
    routerSettings.iterations = Math.max(1, Math.round(routerSettings.iterations));
    routerSettings.maxJumperHoles = Math.max(1, routerSettings.maxJumperHoles);
    return routerSettings;
  }

  function settingsSummary() {
    const settings = syncRouterSettings();
    return Object.entries(settings).map(([key, value]) => `${key}=${value}`).join(" ");
  }

  document.getElementById("planButton").addEventListener("click", plan);
  document.getElementById("placeButton").addEventListener("click", placeOnly);
  document.getElementById("optimizeButton").addEventListener("click", optimize);
  document.getElementById("resetButton").addEventListener("click", reset);

  // ─── Fritzing integration API ─────────────────────────────────────────────

  /**
   * Returns the current router state as a Fritzing-ready JSON object.
   * Call this from Playwright (or any automation) after clicking Plan, Place, or Optimize.
   */
  window.exportSolution = function exportSolution() {
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
      modelValidation: state.modelValidation.map(v => ({ ...v })),
      validation: state.validation.map(v => ({ ...v }))
    };
  };

  /**
   * Runs a full plan+optimize cycle on a custom problem and returns the solution.
   * Suitable for calling from Playwright page.evaluate() without clicking buttons.
   *
   * @param {{ board?, parts?, seed? }} problem
   * @param {{ iterations?, routingRefinement? }} options
   */
  window.solveHeadless = function solveHeadless(problem, options = {}) {
    const savedState = state;
    const savedRandom = Math.random;
    try {
      const seed = problem?.seed ?? options?.seed;
      if (seed !== undefined) {
        let s = seed >>> 0;
        Math.random = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0x100000000; };
      }
      state = new RouterState(
        problem?.parts || sampleParts,
        problem?.board || board
      );
      for (const part of state.boardParts) part.resetFloatingPosition();
      state.silent = true;
      buildInitialPlan({ paint: false, emitLog: false });
      state.silent = false;
      optimize();
      return window.exportSolution();
    } finally {
      state = savedState;
      Math.random = savedRandom;
      render();
    }
  };

  reset();
})();
