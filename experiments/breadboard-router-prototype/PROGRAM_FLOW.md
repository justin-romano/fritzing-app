# Breadboard Router Prototype Program Flow

This diagram is a working map of the current prototype. It is meant to show
what owns data, what mutates state, and what returns derived output.

## Runtime Flow

```mermaid
flowchart TD
  Browser["Browser UI"] --> Buttons["Plan / Place / Optimize / Reset buttons"]

  Buttons -->|Reset| Reset["reset()"]
  Buttons -->|Plan| Plan["plan()"]
  Buttons -->|Place| Place["placeOnly()"]
  Buttons -->|Optimize| Optimize["optimize()"]

  Reset --> Circuit["CircuitDefinition.createState()"]
  Circuit --> State["RouterState"]
  State --> Render["render()"]

  Plan --> Build["buildInitialPlan({ paint, emitLog })"]
  Build --> Clear["clearPlan()"]
  Build --> PlaceParts["placeBoardParts({ emitLog })"]
  Build --> PeripheralAnchors["allocatePeripheralAnchors()"]
  Build --> Route["routeAllNets()"]
  Build --> Metrics["computeMetrics()"]
  Metrics --> Render

  Place --> Clear
  Place --> PlaceParts
  Place --> ClearRoute["state.clearRouteData()"]
  Place --> ClearConnectivity["state.clearConnectivity()"]
  Place --> RebuildAnchors["rebuildAnchors()"]
  Place --> ValidatePhysical["validatePhysicalPlacement()"]
  Place --> Metrics

  Optimize --> MaybeBuild["if no placed parts: buildInitialPlan(false)"]
  MaybeBuild --> Anneal["simulated annealing loop"]
  Anneal --> Snapshot["snapshotLayout()"]
  Anneal --> Release["releasePart(part)"]
  Anneal --> Candidates["generateCandidates(part)"]
  Candidates --> Score["scorePlacement(part, candidate)"]
  Score --> Apply["applyPlacement(part, candidate)"]
  Apply --> Objective["estimatedPlacementObjective()"]
  Objective --> Restore["restoreLayout(bestLayout)"]
  Restore --> PeripheralAnchors
  PeripheralAnchors --> Route

  Render --> View["RouterView.render(state)"]
  View --> Svg["SvgSceneRenderer.render(state)"]
  View --> Panel["PanelRenderer.render(state)"]
```

## Data Ownership

```mermaid
flowchart LR
  Xml["fuzz_netlist.xml-derived net list"] --> NetSpecs["xmlCircuitNets"]
  Synthetic["V1 synthetic battery nets"] --> NetSpecs
  PartSpecs["sampleParts"] --> CircuitDefinition
  NetSpecs --> CircuitDefinition
  BoardSpec["board spec"] --> CircuitDefinition

  CircuitDefinition -->|createState()| RouterState
  RouterState --> Parts["PartModel[]"]
  RouterState --> Board["BreadboardModel"]
  RouterState --> Wires["WirePath[]"]
  RouterState --> Rats["ratline list"]
  RouterState --> Anchors["netAnchors / usedBuses / peripheralLanes"]
  RouterState --> Validation["modelValidation / validation"]
  RouterState --> MetricsState["metrics"]

  Board --> Holes["Hole objects: row, col, bus, x, y, occupiedBy"]
  Parts --> Pins["PinModel[]: connector id, pin name, net"]
```

## Candidate Placement Pipeline

```mermaid
flowchart TD
  Part["PartModel"] --> Generate["generateCandidates(part)"]
  Generate --> Bendable{"2 pins and bendable?"}
  Generate --> TO92{"3-pin transistor or pot?"}
  Generate --> Rigid["generateRigidCandidates(part)"]

  Bendable -->|yes| BendableCandidates["generateTwoPinBendableCandidates(part)"]
  TO92 -->|yes| TransistorCandidates["generateTransistorCandidates(part)"]

  BendableCandidates --> Filter["candidate filters"]
  TransistorCandidates --> Filter
  Rigid --> Filter

  Filter --> OnBoard["onBoard(candidate, part)"]
  Filter --> NoOverlap["!overlaps(candidate, part)"]
  Filter --> BusSafe["candidateRespectsBusOwnership(part, candidate, busOwners)"]

  OnBoard --> Legal["legal candidates"]
  NoOverlap --> Legal
  BusSafe --> Legal

  Legal --> Score["scorePlacement(part, candidate)"]
  Score --> Best["best candidate"]
  Best --> Apply["applyPlacement(part, candidate)"]
  Apply --> Mutations["mutates part.x/y, part.holes, part.pinPoints, hole.occupiedBy"]
```

## Graph Routing Pipeline

```mermaid
flowchart TD
  RouteNet["routeOneNet(net)"] --> Anchors["oneAnchorPerBus(netAnchors[net])"]
  Anchors --> Tree["minimumSpanningTree(bus anchors)"]
  Tree --> Edge["for each tree edge: routeWireSegmentsBetweenHoles(a, b)"]

  Edge --> SameBus{"same breadboard bus?"}
  SameBus -->|yes| NoWire["no jumper needed"]
  SameBus -->|no| BusGraph["graphRouteBetweenBuses(a, b)"]

  BusGraph --> Cache["BusGraphCache built once per route attempt"]
  Cache --> Nodes["nodes = breadboard buses"]
  Cache --> StaticEdges["cached edges = several short jumper choices per bus pair"]
  StaticEdges --> Costs["dynamic edge cost = cached length + jumper penalty + congestion/crossing penalty"]
  Costs --> Dijkstra["shortestBusPath() using MinHeap"]
  Dijkstra --> Segments["return one or more short jumper segments"]

  BusGraph -->|no path| MazeFallback["mazeRouteBetweenHoles(a, b)"]
  Segments --> WirePath["WirePath[]"]
  MazeFallback --> WirePath
  WirePath --> Reserve["state.wires + state.routeSegments"]
```

## Render Pipeline

```mermaid
flowchart TD
  Render["SvgSceneRenderer.render(state)"] --> ClearSvg["svg.replaceChildren()"]
  ClearSvg --> Board["#renderBoard(state)"]
  Board --> Wires["#renderWires(state)"]
  Wires --> Parts["#renderParts(state)"]
  Parts --> Rats["#renderRats(state)"]

  Parts --> Leads["#renderFootprintLeads(part)"]
  Parts --> Bodies["part body + label"]
  Parts --> Contacts["#renderHoleContacts(part)"]
  Parts --> BodyPins["#renderBodyPins(part)"]

  Leads --> Footprint["bodyPinPoints(part) -> path to part.pinPoints holes"]
  Contacts --> HoleData["hole contact circles with part/pin/net/hole data"]
  BodyPins --> PinData["body pin circles with connector/net data"]
```

## Export / Automation Flow

```mermaid
sequenceDiagram
  participant Test as Playwright/test harness
  participant Page as Browser page
  participant App as app.js
  participant State as RouterState

  Test->>Page: load index.html
  Test->>Page: click Plan / Place / Optimize
  Page->>App: event listener calls handler
  App->>State: mutate placement/routing state
  App->>Page: render SVG + panels
  Test->>Page: window.exportSolution()
  Page->>App: collect metrics, placement, wires, validation
  App-->>Test: JSON solution
  Test->>Page: screenshot
```
