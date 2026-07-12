// Netlist -> Fritzing .fz generator.
//
// Emits a sketch whose connectivity lives entirely in schematic-view wires,
// leaving the breadboard view as pure ratsnest demands for the breadboard
// autorouter. Parts are scattered loose around a full-size breadboard.
//
// Usage: node generate.mjs > bigmuff.fz   (then zip as .fzz)

const PARTS_ROOT = 'F:/src/fritzing-app/release64/fritzing-parts/core';

const LIBRARY = {
	resistor: {
		moduleIdRef: 'ResistorModuleID',
		path: `${PARTS_ROOT}/resistor.fzp`,
		propertyName: 'resistance',
	},
	ceramic: {
		moduleIdRef: '100milCeramicCapacitorModuleID',
		path: `${PARTS_ROOT}/capacitor_ceramic_100mil.fzp`,
		propertyName: 'capacitance',
	},
	electrolytic: {
		moduleIdRef: 'SmallElectrolyticCapacitorModuleID',
		path: `${PARTS_ROOT}/capacitor_electrolytic_small.fzp`,
		propertyName: 'capacitance',
	},
	npn: {
		moduleIdRef: 'NPN-to92-ebc',
		path: `${PARTS_ROOT}/transistor_signal_NPN_TO92_EBC.fzp`,
	},
	diode: {
		moduleIdRef: 'SparkFun-DiscreteSemi-DIODE-1N4148_v2',
		path: `${PARTS_ROOT}/sparkfun-discretesemi-diode-1n4148_v2.fzp`,
	},
	pot: {
		moduleIdRef: 'alps-starter-pot9mm',
		path: `${PARTS_ROOT}/alps-starter-pot9mm.fzp`,
	},
	jack: {
		moduleIdRef: 'SparkFun-Connectors-AUDIO-JACK-2.5MM',
		path: `${PARTS_ROOT}/sparkfun-connectors-audio-jack-2.5mm.fzp`,
	},
	power: {
		moduleIdRef: 'DC2PowerModuleID',
		path: `${PARTS_ROOT}/dcpower2.fzp`,
	},
	breadboard: {
		moduleIdRef: 'BreadboardModuleID',
		path: `${PARTS_ROOT}/breadboard.fzp`,
	},
};

// Pin aliases per part type -> Fritzing connector ids.
const PINS = {
	resistor: { 1: 'connector0', 2: 'connector1' },
	ceramic: { 1: 'connector0', 2: 'connector1' },
	electrolytic: { neg: 'connector0', pos: 'connector1' },
	npn: { E: 'connector0', B: 'connector1', C: 'connector2' },
	diode: { A: 'connector0', K: 'connector1' },
	pot: { 1: 'connector0', W: 'connector1', 3: 'connector2' },
	jack: { S: 'connector0', T: 'connector2' },
	power: { 'V+': 'connector0', 'V-': 'connector1' },
};

// ---------------------------------------------------------------- Big Muff Pi
const parts = [
	{ ref: 'BB1', type: 'breadboard' },
	{ ref: 'JIN', type: 'jack' },
	{ ref: 'JOUT', type: 'jack' },
	{ ref: 'V1', type: 'power' },
	{ ref: 'Q1', type: 'npn' }, { ref: 'Q2', type: 'npn' },
	{ ref: 'Q3', type: 'npn' }, { ref: 'Q4', type: 'npn' },
	{ ref: 'D1', type: 'diode' }, { ref: 'D2', type: 'diode' },
	{ ref: 'D3', type: 'diode' }, { ref: 'D4', type: 'diode' },
	{ ref: 'SUS', type: 'pot' }, { ref: 'TONE', type: 'pot' }, { ref: 'VOL', type: 'pot' },
	{ ref: 'R1', type: 'resistor', value: '39k' },
	{ ref: 'R2', type: 'resistor', value: '470k' },
	{ ref: 'R3', type: 'resistor', value: '12k' },
	{ ref: 'R4', type: 'resistor', value: '390' },
	{ ref: 'R5', type: 'resistor', value: '102k' },
	{ ref: 'R7', type: 'resistor', value: '470k' },
	{ ref: 'R8', type: 'resistor', value: '12k' },
	{ ref: 'R9', type: 'resistor', value: '390' },
	{ ref: 'R10', type: 'resistor', value: '102k' },
	{ ref: 'R11', type: 'resistor', value: '10k' },
	{ ref: 'R12', type: 'resistor', value: '470k' },
	{ ref: 'R13', type: 'resistor', value: '12k' },
	{ ref: 'R14', type: 'resistor', value: '390' },
	{ ref: 'R15', type: 'resistor', value: '102k' },
	{ ref: 'R16', type: 'resistor', value: '39k' },
	{ ref: 'R17', type: 'resistor', value: '22k' },
	{ ref: 'R18', type: 'resistor', value: '470k' },
	{ ref: 'R19', type: 'resistor', value: '12k' },
	{ ref: 'R20', type: 'resistor', value: '390' },
	{ ref: 'R21', type: 'resistor', value: '102k' },
	{ ref: 'C1', type: 'ceramic', value: '100nF' },
	{ ref: 'C2', type: 'ceramic', value: '100nF' },
	{ ref: 'C3', type: 'ceramic', value: '100nF' },
	{ ref: 'C4', type: 'ceramic', value: '47nF' },
	{ ref: 'C5', type: 'ceramic', value: '100nF' },
	{ ref: 'C6', type: 'ceramic', value: '47nF' },
	{ ref: 'C8', type: 'ceramic', value: '10nF' },
	{ ref: 'C9', type: 'ceramic', value: '4.7nF' },
	{ ref: 'C10', type: 'ceramic', value: '100nF' },
	{ ref: 'C11', type: 'ceramic', value: '100nF' },
	{ ref: 'C12', type: 'electrolytic', value: '100uF' },
];

// Each net is a list of "REF.pin" endpoints (pin per PINS alias table).
const nets = [
	// power and ground
	['V1.V+', 'R3.2', 'R8.2', 'R13.2', 'R19.2', 'R18.2', 'C12.pos'],
	['V1.V-', 'JIN.S', 'JOUT.S', 'R1.2', 'R4.2', 'R5.2', 'R9.2', 'R10.2',
	 'R14.2', 'R15.2', 'R16.2', 'R20.2', 'R21.2', 'SUS.1', 'C9.2', 'VOL.1', 'C12.neg'],
	// input stage
	['JIN.T', 'R1.1', 'C1.1'],
	['C1.2', 'Q1.B', 'R2.1', 'R5.1'],
	['Q1.C', 'R2.2', 'R3.1', 'C2.1'],
	['Q1.E', 'R4.1'],
	// sustain pot into first clipping stage
	['C2.2', 'SUS.3'],
	['SUS.W', 'C3.1'],
	['C3.2', 'Q2.B', 'R7.1', 'R10.1', 'C4.1'],
	['C4.2', 'D1.A', 'D2.K'],
	['Q2.C', 'R7.2', 'R8.1', 'D1.K', 'D2.A', 'C5.1'],
	['Q2.E', 'R9.1'],
	// second clipping stage
	['C5.2', 'R11.1'],
	['R11.2', 'Q3.B', 'R12.1', 'R15.1', 'C6.1'],
	['C6.2', 'D3.A', 'D4.K'],
	['Q3.C', 'R12.2', 'R13.1', 'D3.K', 'D4.A', 'C8.1', 'R17.1'],
	['Q3.E', 'R14.1'],
	// bridged-T tone stack
	['C8.2', 'R16.1', 'TONE.1'],
	['R17.2', 'C9.1', 'TONE.3'],
	// output stage
	['TONE.W', 'C10.1'],
	['C10.2', 'Q4.B', 'R18.1', 'R21.1'],
	['Q4.C', 'R19.1', 'C11.1'],
	['Q4.E', 'R20.1'],
	['C11.2', 'VOL.3'],
	['VOL.W', 'JOUT.T'],
];

// ------------------------------------------------------------------ layout
// Breadboard-view: breadboard at origin, everything else scattered below it.
// Schematic-view: coarse grid, wires drawn point to point (correct, not pretty).
const bbPositions = { BB1: { x: 0, y: -150 } };
const schPositions = { BB1: { x: -400, y: -400 } };
{
	let i = 0;
	for (const part of parts) {
		if (part.ref === 'BB1') continue;
		bbPositions[part.ref] = { x: -260 + (i % 8) * 90, y: 320 + Math.floor(i / 8) * 70 };
		schPositions[part.ref] = { x: (i % 8) * 160, y: Math.floor(i / 8) * 130 };
		i++;
	}
}

// ------------------------------------------------------------------ emit
let nextModelIndex = 9000;
const partByRef = new Map();
for (const part of parts) {
	part.modelIndex = nextModelIndex++;
	part.lib = LIBRARY[part.type];
	// schematic connects collected per connectorId
	part.schConnects = new Map();
	partByRef.set(part.ref, part);
}

function resolve(endpoint) {
	const [ref, pin] = endpoint.split('.');
	const part = partByRef.get(ref);
	if (!part) throw new Error(`unknown part ${ref}`);
	const connectorId = PINS[part.type][pin];
	if (!connectorId) throw new Error(`unknown pin ${endpoint}`);
	return { part, connectorId };
}

const wires = [];
for (const net of nets) {
	for (let i = 0; i + 1 < net.length; i++) {
		const from = resolve(net[i]);
		const to = resolve(net[i + 1]);
		const wire = {
			modelIndex: nextModelIndex++,
			from,
			to,
		};
		wires.push(wire);
		for (const [end, other] of [[from, wire], [to, wire]]) {
			if (!end.part.schConnects.has(end.connectorId))
				end.part.schConnects.set(end.connectorId, []);
			end.part.schConnects.get(end.connectorId).push({ wire: other, endIndex: end === from ? 0 : 1 });
		}
	}
}

function esc(text) {
	return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function partXml(part) {
	const bb = bbPositions[part.ref];
	const sch = schPositions[part.ref];
	const props = part.value && part.lib.propertyName
		? `\n        <property name="${part.lib.propertyName}" value="${esc(part.value)}"/>`
		: '';
	let schConnectors = '';
	if (part.schConnects.size > 0) {
		const items = [];
		for (const [connectorId, hits] of part.schConnects) {
			const connects = hits.map(({ wire, endIndex }) =>
				`                            <connect connectorId="connector${endIndex}" modelIndex="${wire.modelIndex}" layer="schematicTrace"/>`).join('\n');
			items.push(`                    <connector connectorId="${connectorId}" layer="schematic">
                        <geometry x="0" y="0"/>
                        <connects>
${connects}
                        </connects>
                    </connector>`);
		}
		schConnectors = `\n                <connectors>\n${items.join('\n')}\n                </connectors>`;
	}
	return `        <instance moduleIdRef="${part.lib.moduleIdRef}" modelIndex="${part.modelIndex}" path="${part.lib.path}">${props}
            <title>${esc(part.ref)}</title>
            <views>
                <breadboardView layer="breadboard">
                    <geometry z="2.5" x="${bb.x}" y="${bb.y}"/>
                </breadboardView>
                <schematicView layer="schematic">
                    <geometry z="2.5" x="${sch.x}" y="${sch.y}"/>${schConnectors}
                </schematicView>
            </views>
        </instance>`;
}

function wireXml(wire, index) {
	const a = schPositions[wire.from.part.ref];
	const b = schPositions[wire.to.part.ref];
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	return `        <instance moduleIdRef="WireModuleID" modelIndex="${wire.modelIndex}" path=":/resources/parts/core/wire.fzp">
            <title>W${index + 1}</title>
            <views>
                <schematicView layer="schematicTrace">
                    <geometry z="5.5" x="${a.x}" y="${a.y}" x1="0" y1="0" x2="${dx}" y2="${dy}" wireFlags="128"/>
                    <wireExtras mils="9.7222" color="#404040" opacity="1" banded="0"/>
                    <connectors>
                        <connector connectorId="connector0" layer="schematicTrace">
                            <geometry x="0" y="0"/>
                            <connects>
                                <connect connectorId="${wire.from.connectorId}" modelIndex="${wire.from.part.modelIndex}" layer="schematic"/>
                            </connects>
                        </connector>
                        <connector connectorId="connector1" layer="schematicTrace">
                            <geometry x="0" y="0"/>
                            <connects>
                                <connect connectorId="${wire.to.connectorId}" modelIndex="${wire.to.part.modelIndex}" layer="schematic"/>
                            </connects>
                        </connector>
                    </connectors>
                </schematicView>
            </views>
        </instance>`;
}

const doc = `<?xml version="1.0" encoding="UTF-8"?>
<module fritzingVersion="1.0.6" icon=".png">
    <views>
        <view name="breadboardView" backgroundColor="#ffffff" gridSize="0.1in" showGrid="1" alignToGrid="1" viewFromBelow="0" colorWiresByLength="0"/>
        <view name="schematicView" backgroundColor="#ffffff" gridSize="0.1in" showGrid="1" alignToGrid="1" viewFromBelow="0"/>
        <view name="pcbView" backgroundColor="#333333" gridSize="0.1in" showGrid="1" alignToGrid="1" viewFromBelow="0"/>
    </views>
    <instances>
${parts.map(partXml).join('\n')}
${wires.map(wireXml).join('\n')}
    </instances>
</module>
`;

process.stdout.write(doc);
process.stderr.write(`parts=${parts.length} wires=${wires.length} nets=${nets.length}\n`);
