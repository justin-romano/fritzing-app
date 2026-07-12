/*******************************************************************

Part of the Fritzing project - http://fritzing.org
Copyright (c) 2007-2019 Fritzing

Fritzing is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

Fritzing is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with Fritzing.  If not, see <http://www.gnu.org/licenses/>.

********************************************************************/

#include "breadboardautorouter.h"
#include "breadboardpartpolicy.h"
#include "breadboardroutegraph.h"
#include "breadboardroutegraphcore.h"
#include "breadboardtopology.h"

#include <climits>
#include <functional>
#include <memory>

#include <QHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QGraphicsScene>
#include <QGraphicsItem>
#include <QSet>
#include <QSettings>
#include <QStandardPaths>
#include <QTextStream>
#include <QtMath>
#include <QMessageBox>
#include <QElapsedTimer>
#include <QUndoCommand>
#include <algorithm>
#include <limits>

#include "../commands.h"
#include "../items/itembase.h"
#include "../items/wire.h"
#include "../sketch/breadboardsketchwidget.h"
#include "../waitpushundostack.h"

namespace
{
	// How to swap the two pin positions of a part so crossed legs uncross
	// while every net stays on its own pin. Mirroring keeps the body visually
	// upright and is preferred when the part's fzp allows it; parts without
	// flip support (e.g. resistors, which are axially symmetric anyway) fall
	// back to a 180 degree rotation.
	enum class PinSwap
	{
		None,
		FlipHorizontal,
		FlipVertical,
		Rotate180
	};

	QPointF swappedPoint(const QPointF &point, PinSwap swap, const QPointF &center)
	{
		switch (swap)
		{
		case PinSwap::FlipHorizontal:
			return QPointF(center.x() * 2.0 - point.x(), point.y());
		case PinSwap::FlipVertical:
			return QPointF(point.x(), center.y() * 2.0 - point.y());
		case PinSwap::Rotate180:
			return center * 2.0 - point;
		default:
			return point;
		}
	}

	struct PlacementCandidate
	{
		ItemBase *item = nullptr;
		QPointF oldLoc;
		QPointF newLoc;
		QHash<ConnectorItem *, ConnectorItem *> pinToHole;
		QHash<ConnectorItem *, QPolygonF> pinToLeg;
		double score = std::numeric_limits<double>::max();
		bool usesLegPlacement = false;
		PinSwap pinSwap = PinSwap::None;
	};

	constexpr double FlipRotationDegrees = 180.0;

	constexpr double HoleMatchTolerance = 12.0;
	constexpr double PlacementKeepoutMargin = 8.0;
	constexpr double BendablePlacementKeepoutMargin = 1.0;

	ViewGeometry::WireFlags generatedWireFlags()
	{
		return ViewGeometry::NormalFlag | ViewGeometry::AutoroutableFlag;
	}

	QLineF connectorLine(ConnectorItem *from, ConnectorItem *to)
	{
		if (from == nullptr || to == nullptr) return QLineF();
		return QLineF(from->sceneAdjustedTerminalPoint(nullptr), to->sceneAdjustedTerminalPoint(nullptr));
	}

	// A female connector only counts as a breadboard hole when its owner IS
	// a breadboard. Breakout boards (LSM303C etc.) have female header
	// sockets too; treating those as holes turned them into phantom board
	// anchors that routing could never reach.
	bool isBreadboardHoleConnector(ConnectorItem *connectorItem)
	{
		if (connectorItem == nullptr || connectorItem->connectorType() != Connector::Female)
			return false;
		ItemBase *owner = connectorItem->attachedTo();
		if (owner == nullptr)
			return false;
		return BreadboardTopology::isBreadboardItem(owner->layerKinChief());
	}

	BreadboardRouteGraphCore::Options coreRouteOptions()
	{
		const BreadboardRouteGraph::Options env = BreadboardRouteGraph::Options::fromEnvironment();
		BreadboardRouteGraphCore::Options options;
		options.maxJumperLength = env.maxJumperLength;
		options.jumperPenalty = env.jumperPenalty;
		options.crossingPenalty = env.crossingPenalty;
		options.overlapPenalty = env.overlapPenalty;
		options.candidatesPerBusPair = env.candidatesPerBusPair;
		return options;
	}

	// Builds the static bus graph ONCE per routing pass. Everything that
	// changes as routing proceeds - reserved holes and planned segments -
	// is supplied per route() query. Results are mapped back to the old
	// ConnectorItem-based Result so call sites stay unchanged.
	struct RouteGraphSession
	{
		QList<ConnectorItem *> holes;
		QHash<ConnectorItem *, int> indexForHole;
		QVector<bool> baseBlocked;
		QVector<int> busGroupForHole;    // global bus group id per hole
		QVector<int> denseBusForHole;    // session-dense bus id per hole
		int denseBusCount = 0;
		std::function<int(int)> ownerOfBusGroup;
		std::shared_ptr<BreadboardRouteGraphCore> core;

		static RouteGraphSession build(const QList<ConnectorItem *> &routeHoles,
									   const std::function<int(ConnectorItem *)> &busGroup,
									   const std::function<int(int)> &ownerOfBusGroup)
		{
			RouteGraphSession session;
			session.holes = routeHoles;
			session.ownerOfBusGroup = ownerOfBusGroup;
			QVector<QPointF> positions(routeHoles.count());
			QVector<int> busIds(routeHoles.count(), -1);
			session.baseBlocked = QVector<bool>(routeHoles.count(), false);
			session.busGroupForHole = QVector<int>(routeHoles.count(), -1);
			QHash<int, int> denseBusFor;
			for (int i = 0; i < routeHoles.count(); i++)
			{
				ConnectorItem *hole = routeHoles.at(i);
				if (hole == nullptr)
					continue;
				session.indexForHole.insert(hole, i);
				positions[i] = hole->sceneAdjustedTerminalPoint(nullptr);
				const int group = busGroup(hole);
				session.busGroupForHole[i] = group;
				auto found = denseBusFor.constFind(group);
				if (found == denseBusFor.constEnd())
				{
					busIds[i] = denseBusFor.count();
					denseBusFor.insert(group, busIds[i]);
				}
				else
				{
					busIds[i] = found.value();
				}
				// Occupancy is stable during a pass: wire commands only
				// execute at push, after routing has finished.
				session.baseBlocked[i] = hole->connectionsCount() != 0;
			}
			session.denseBusForHole = busIds;
			session.denseBusCount = denseBusFor.count();
			session.core = std::make_shared<BreadboardRouteGraphCore>(positions, busIds, coreRouteOptions());
			return session;
		}

		// Build once per batch of route() calls sharing the same reserved
		// set, planned segments, and querying net - this replaces the old
		// per-batch graph reconstruction at a fraction of its cost. Buses
		// owned by any other key are blocked outright (prime invariant).
		BreadboardRouteGraphCore::QueryContext prepare(const QSet<ConnectorItem *> &reserved,
													   const QList<QLineF> &plannedSegments,
													   int netOwnerKey) const
		{
			QVector<bool> blocked = baseBlocked;
			Q_FOREACH (ConnectorItem *hole, reserved)
			{
				const int index = indexForHole.value(hole, -1);
				if (index >= 0)
					blocked[index] = true;
			}
			QVector<bool> busBlocked(denseBusCount, false);
			for (int i = 0; i < holes.count(); i++)
			{
				const int dense = denseBusForHole.at(i);
				if (dense < 0 || busBlocked.at(dense))
					continue;
				const int owner = ownerOfBusGroup ? ownerOfBusGroup(busGroupForHole.at(i)) : -1;
				if (owner != -1 && owner != netOwnerKey)
					busBlocked[dense] = true;
			}
			return core->prepareQuery(blocked, busBlocked, plannedSegments);
		}

		BreadboardRouteGraph::Result mapResult(const BreadboardRouteGraphCore::Result &result) const
		{
			BreadboardRouteGraph::Result mapped;
			mapped.found = result.found;
			mapped.cost = result.cost;
			mapped.score = result.score;
			mapped.reason = result.reason;
			Q_FOREACH (const BreadboardRouteGraphCore::Segment &segment, result.segments)
			{
				BreadboardRouteGraph::Segment mappedSegment;
				mappedSegment.from = holes.at(segment.fromHole);
				mappedSegment.to = holes.at(segment.toHole);
				mappedSegment.cost = segment.cost;
				mapped.segments.append(mappedSegment);
			}
			return mapped;
		}

		BreadboardRouteGraph::Result route(ConnectorItem *from, ConnectorItem *to,
										   const BreadboardRouteGraphCore::QueryContext &context) const
		{
			const int fromIndex = indexForHole.value(from, -1);
			const int toIndex = indexForHole.value(to, -1);
			if (fromIndex < 0 || toIndex < 0)
			{
				BreadboardRouteGraph::Result mapped;
				mapped.reason = "endpoint is not a routable breadboard hole";
				return mapped;
			}
			return mapResult(core->route(fromIndex, toIndex, context));
		}

		// One Dijkstra from `source` answers every later extract() in O(path).
		BreadboardRouteGraphCore::MultiResult routeFrom(ConnectorItem *source,
														const BreadboardRouteGraphCore::QueryContext &context) const
		{
			const int index = indexForHole.value(source, -1);
			if (index < 0)
				return BreadboardRouteGraphCore::MultiResult();
			return core->routeFrom(index, context);
		}

		BreadboardRouteGraph::Result extract(const BreadboardRouteGraphCore::MultiResult &multi,
											 ConnectorItem *target) const
		{
			const int index = indexForHole.value(target, -1);
			if (index < 0)
			{
				BreadboardRouteGraph::Result mapped;
				mapped.reason = "endpoint is not a routable breadboard hole";
				return mapped;
			}
			return mapResult(core->extractRoute(multi, index));
		}
	};

	double leadCongestionPenalty(ConnectorItem *from, ConnectorItem *to, const QList<QLineF> &plannedSegments)
	{
		const BreadboardRouteGraph::Options options = BreadboardRouteGraph::Options::fromEnvironment();
		return BreadboardRouteGraph::congestionPenalty(connectorLine(from, to),
		                                                   plannedSegments,
		                                                   options.crossingPenalty,
		                                                   options.overlapPenalty);
	}

	struct HoleBounds
	{
		bool valid = false;
		double minX = 0.0;
		double maxX = 0.0;
		double minY = 0.0;
		double maxY = 0.0;
	};

	double manhattanDistance(const QPointF &a, const QPointF &b)
	{
		return qAbs(a.x() - b.x()) + qAbs(a.y() - b.y());
	}

	double polylineLength(const QPolygonF &polygon)
	{
		double length = 0.0;
		for (int i = 1; i < polygon.count(); i++) length += QLineF(polygon.at(i - 1), polygon.at(i)).length();
		return length;
	}

	bool routeIsBetter(const BreadboardRouteGraph::Result &candidate,
	                   const BreadboardRouteGraph::Result &current)
	{
		return candidate.found && (!current.found || candidate.score < current.score);
	}

	HoleBounds boundsForHoles(const QList<ConnectorItem *> &holes)
	{
		HoleBounds bounds;
		Q_FOREACH (ConnectorItem *hole, holes)
		{
			if (hole == nullptr)
				continue;
			const QPointF point = hole->sceneAdjustedTerminalPoint(nullptr);
			if (!bounds.valid)
			{
				bounds.valid = true;
				bounds.minX = bounds.maxX = point.x();
				bounds.minY = bounds.maxY = point.y();
				continue;
			}
			bounds.minX = qMin(bounds.minX, point.x());
			bounds.maxX = qMax(bounds.maxX, point.x());
			bounds.minY = qMin(bounds.minY, point.y());
			bounds.maxY = qMax(bounds.maxY, point.y());
		}
		return bounds;
	}

	double boardEdgeEntryScore(ConnectorItem *terminal, ConnectorItem *entry, const HoleBounds &bounds)
	{
		if (terminal == nullptr || entry == nullptr || !bounds.valid)
		{
			return std::numeric_limits<double>::max();
		}

		const QPointF terminalPoint = terminal->sceneAdjustedTerminalPoint(nullptr);
		const QPointF entryPoint = entry->sceneAdjustedTerminalPoint(nullptr);
		const double centerX = (bounds.minX + bounds.maxX) * 0.5;
		const double centerY = (bounds.minY + bounds.maxY) * 0.5;

		// Peripheral wires should enter at the breadboard edge facing the part.
		// This keeps long off-board leads out of the middle of the board and lets
		// the bus graph handle board-local jumpers from that entry point.
		double edgeDistance = 0.0;
		double perpendicularDistance = 0.0;
		if (terminalPoint.x() < bounds.minX)
		{
			edgeDistance = qAbs(entryPoint.x() - bounds.minX);
			perpendicularDistance = qAbs(entryPoint.y() - terminalPoint.y()) * 0.35;
		}
		else if (terminalPoint.x() > bounds.maxX)
		{
			edgeDistance = qAbs(entryPoint.x() - bounds.maxX);
			perpendicularDistance = qAbs(entryPoint.y() - terminalPoint.y()) * 0.35;
		}
		else if (terminalPoint.y() < bounds.minY)
		{
			edgeDistance = qAbs(entryPoint.y() - bounds.minY);
			perpendicularDistance = qAbs(entryPoint.x() - terminalPoint.x()) * 0.35;
		}
		else if (terminalPoint.y() > bounds.maxY)
		{
			edgeDistance = qAbs(entryPoint.y() - bounds.maxY);
			perpendicularDistance = qAbs(entryPoint.x() - terminalPoint.x()) * 0.35;
		}
		else
		{
			const double left = qAbs(entryPoint.x() - bounds.minX);
			const double right = qAbs(entryPoint.x() - bounds.maxX);
			const double top = qAbs(entryPoint.y() - bounds.minY);
			const double bottom = qAbs(entryPoint.y() - bounds.maxY);
			edgeDistance = qMin(qMin(left, right), qMin(top, bottom));
			perpendicularDistance = manhattanDistance(entryPoint, QPointF(centerX, centerY)) * 0.1;
		}

		return edgeDistance * 8.0 + perpendicularDistance + manhattanDistance(terminalPoint, entryPoint) * 0.1;
	}

	QPolygonF translatedLegForTarget(ConnectorItem *pin, const QPointF &offset, ConnectorItem *hole,
									 PinSwap swap = PinSwap::None, const QPointF &swapCenter = QPointF())
	{
		QPolygonF translated;
		if (pin == nullptr || hole == nullptr)
			return translated;

		// Do not preserve the leg's historical bend points: after the part
		// moves they describe a stale shape, and snapping only the endpoint
		// to the hole produces zigzag leads. Bend a fresh straight lead from
		// the leg root at the body to the assigned hole instead.
		QPolygonF oldLeg = pin->sceneAdjustedLeg();
		QPointF root = oldLeg.count() >= 2
			? oldLeg.first()
			: pin->sceneAdjustedTerminalPoint(nullptr);
		root = swappedPoint(root, swap, swapCenter);
		translated << root + offset;
		translated << hole->sceneAdjustedTerminalPoint(nullptr);
		return translated;
	}

	bool allPinsHaveBendableLegs(const QList<ConnectorItem *> &pins)
	{
		if (pins.isEmpty())
			return false;
		Q_FOREACH (ConnectorItem *pin, pins)
		{
			if (pin == nullptr || !pin->hasRubberBandLeg())
				return false;
		}
		return true;
	}

	QList<ConnectorItem *> freeBusHoles(ConnectorItem *breadboardHole, const QList<ConnectorItem *> &allowedHoles, const QSet<ConnectorItem *> &reservedHoles)
	{
		QList<ConnectorItem *> result;
		if (breadboardHole == nullptr)
			return result;

		ItemBase *breadboard = breadboardHole->attachedTo();
		if (breadboard == nullptr)
			return result;

		QList<ConnectorItem *> busHoles;
		if (!breadboard->busConnectorItems(breadboardHole, busHoles))
			return result;

		Q_FOREACH (ConnectorItem *candidate, busHoles)
		{
			if (candidate == nullptr)
				continue;
			if (!allowedHoles.contains(candidate))
				continue;
			if (reservedHoles.contains(candidate))
				continue;
			if (candidate->connectorType() != Connector::Female)
				continue;
			if (candidate->connectionsCount() != 0)
				continue;
			if (!candidate->attachedTo()->isEverVisible())
				continue;
			if (!result.contains(candidate))
				result.append(candidate);
		}

		std::sort(result.begin(), result.end(), [breadboardHole](ConnectorItem *a, ConnectorItem *b)
				  {
		QPointF origin = breadboardHole->sceneAdjustedTerminalPoint(nullptr);
		double ad = QLineF(origin, a->sceneAdjustedTerminalPoint(nullptr)).length();
		double bd = QLineF(origin, b->sceneAdjustedTerminalPoint(nullptr)).length();
		return ad < bd; });

		return result;
	}
}

BreadboardAutorouter::BreadboardAutorouter(BreadboardSketchWidget *sketchWidget)
	: m_sketchWidget(sketchWidget)
{
}

QString BreadboardAutorouter::PhaseStats::toString() const
{
	return QString("clear=%1ms collect=%2ms placeSearch=%3ms placeExec=%4ms routeSearch=%5ms routeExec=%6ms completion=%7ms cleanup=%8ms")
		.arg(clearMs)
		.arg(collectMs)
		.arg(placeSearchMs)
		.arg(placeExecMs)
		.arg(routeSearchMs)
		.arg(routeExecMs)
		.arg(completionMs)
		.arg(cleanupMs);
}

BreadboardAutorouter::~BreadboardAutorouter()
{
	clearCollectedNets();
}

void BreadboardAutorouter::start()
{
	if (m_sketchWidget == nullptr)
		return;
	QElapsedTimer elapsed;
	elapsed.start();
	m_componentLeadLength = 0.0;
	m_lastRoutingScore = BreadboardRoutingScore();
	m_phaseStats = PhaseStats();
	QElapsedTimer phaseTimer;
	phaseTimer.start();
	auto takePhaseMs = [&phaseTimer]() {
		const qint64 ms = phaseTimer.elapsed();
		phaseTimer.restart();
		return ms;
	};

	QFile::remove(logFilePath());
	logAutoroute("========== breadboard autoroute start ==========");
	logAutoroute(QString("log file: %1").arg(logFilePath()));
	loadTuning();
	logAutoroute(QString("tuning: maxLegLength=%1 leadLengthWeight=%2 jumperPenalty=%3 leadAngleWeight=%4 foldbackWeight=%5")
				 .arg(m_maxLegLength)
				 .arg(m_leadLengthWeight)
				 .arg(m_jumperPenalty)
				 .arg(m_leadAngleWeight)
				 .arg(m_foldbackWeight));
	// Flush immediately so external watchers see the log recreated at start.
	flushAutorouteLog();

	auto *undoStack = m_sketchWidget->undoStack();
	const int undoCountBefore = undoStack->count();
	const int undoIndexBefore = undoStack->index();
	logAutoroute(QString("undo transaction begin: count=%1 index=%2")
				 .arg(undoCountBefore)
				 .arg(undoIndexBefore));
	undoStack->beginMacro(QObject::tr("Breadboard autoroute"));

	invalidateRoutingCaches();
	phaseTimer.restart();
	const int cleared = clearPreviousAutorouteWires();
	m_phaseStats.clearMs = takePhaseMs();
	invalidateRoutingCaches();
	if (cleared > 0)
	{
		logAutoroute(QString("clear complete: removedWires=%1").arg(cleared));
		Q_EMIT setProgressMessage(QObject::tr("Cleared previous breadboard routes..."));
		Q_EMIT setProgressMessage2(QObject::tr("Removed %1 generated breadboard wire(s).").arg(cleared));
	}

	clearCollectedNets();

	QHash<ConnectorItem *, int> indexer;
	m_sketchWidget->collectAllNets(indexer, m_allPartConnectorItems, false, false, false);
	m_phaseStats.collectMs = takePhaseMs();
	logAutoroute(QString("collectAllNets: nets=%1 indexer=%2").arg(m_allPartConnectorItems.count()).arg(indexer.count()));

	if (m_allPartConnectorItems.isEmpty())
	{
		undoStack->endMacro();
		logAutoroute("abort: no breadboard connections to route");
		flushAutorouteLog();
		QMessageBox::information(nullptr, QObject::tr("Fritzing"), QObject::tr("No breadboard connections to route."));
		return;
	}

	Q_EMIT setMaximumProgress(m_allPartConnectorItems.count());
	Q_EMIT setProgressValue(0);
	Q_EMIT setProgressMessage(QObject::tr("Placing breadboard parts..."));
	Q_EMIT setProgressMessage2(QString());

	// Prime invariant machinery: seed bus ownership from existing
	// connections and record net contacts that already exist so the
	// post-route conformance audit only fails on connections WE created.
	seedBusOwnership();
	m_preExistingNetContacts.clear();
	{
		QStringList ignored;
		verifySchematicConformance(ignored, true);
		if (!m_preExistingNetContacts.isEmpty())
			logAutoroute(QString("pre-existing net contacts (exempt from audit): %1").arg(m_preExistingNetContacts.count()));
	}

	phaseTimer.restart();
	int placed = autoplacePartsOnBreadboard();
	// placeExecMs is recorded inside autoplace around its command push.
	m_phaseStats.placeSearchMs = takePhaseMs() - m_phaseStats.placeExecMs;
	logAutoroute(QString("undo transaction after placement: count=%1 index=%2")
				 .arg(undoStack->count())
				 .arg(undoStack->index()));
	logAutoroute(QString("autoplace complete: placed=%1").arg(placed));
	if (placed < 0)
	{
		clearCollectedNets();
		undoStack->endMacro();
		undoStack->undo();
		logAutoroute("abort: placement connection verification failed; transaction rolled back");
		flushAutorouteLog();
		QMessageBox messageBox(QMessageBox::Critical,
							   QObject::tr("Fritzing"),
							   QObject::tr("Breadboard placement produced detached component pins and was rolled back."));
		messageBox.setDetailedText(m_lastPlacementReport);
		messageBox.exec();
		return;
	}
	if (placed > 0)
	{
		clearCollectedNets();
		indexer.clear();
		m_sketchWidget->collectAllNets(indexer, m_allPartConnectorItems, false, false, false);
		logAutoroute(QString("collectAllNets after placement: nets=%1 indexer=%2").arg(m_allPartConnectorItems.count()).arg(indexer.count()));
		Q_EMIT setMaximumProgress(m_allPartConnectorItems.count());
	}

	Q_EMIT setProgressMessage(QObject::tr("Routing breadboard jumpers..."));

	auto *parentCommand = new QUndoCommand(QObject::tr("Route breadboard jumpers"));

	phaseTimer.restart();
	int created = routeCollectedNets(parentCommand);
	m_phaseStats.routeSearchMs = takePhaseMs();
	logAutoroute(QString("route complete: createdWires=%1").arg(created));

	Q_EMIT setProgressValue(m_allPartConnectorItems.count());

	if (placed <= 0 && created <= 0)
	{
		delete parentCommand;
		undoStack->endMacro();
		logAutoroute(QString("undo transaction empty end: count=%1 index=%2 delta=%3")
					 .arg(undoStack->count())
					 .arg(undoStack->index())
					 .arg(undoStack->count() - undoCountBefore));
		logAutoroute("abort: no valid placement or route");
		if (!m_lastPlacementReport.isEmpty())
			logAutoroute(QString("placement report:\n%1").arg(m_lastPlacementReport));
		flushAutorouteLog();
		QMessageBox messageBox(QMessageBox::Information,
							   QObject::tr("Fritzing"),
							   QObject::tr("Breadboard autoroute did not find a valid placement or route."));
		if (!m_lastPlacementReport.isEmpty())
		{
			messageBox.setDetailedText(m_lastPlacementReport);
		}
		messageBox.exec();
		return;
	}

	new CleanUpRatsnestsCommand(m_sketchWidget, CleanUpWiresCommand::RedoOnly, parentCommand);
	new CleanUpWiresCommand(m_sketchWidget, CleanUpWiresCommand::RedoOnly, parentCommand);
	phaseTimer.restart();
	undoStack->push(parentCommand);
	m_phaseStats.routeExecMs = takePhaseMs();
	// Pushed commands created wires: the cached wire-ends list is stale.
	invalidateRoutingCaches();

	// The net-level planner minimizes jumpers, but Fritzing's ratsnest model is
	// the authoritative completion check. Route only demands that remain after
	// the optimized commands have executed; never report success over ratnests.
	int residualRatsnests = countUnresolvedNets();
	if (residualRatsnests > 0)
	{
		logAutoroute(QString("completion pass begin: residualRatsnests=%1").arg(residualRatsnests));
		auto *completionCommand = new QUndoCommand(QObject::tr("Complete breadboard routes"));
		const int completed = routeRatsnestDemands(completionCommand);
		if (completed > 0)
		{
			new CleanUpRatsnestsCommand(m_sketchWidget, CleanUpWiresCommand::RedoOnly, completionCommand);
			new CleanUpWiresCommand(m_sketchWidget, CleanUpWiresCommand::RedoOnly, completionCommand);
			undoStack->push(completionCommand);
			invalidateRoutingCaches();
			created += completed;
		}
		else
		{
			delete completionCommand;
		}
		residualRatsnests = countUnresolvedNets();
		logAutoroute(QString("completion pass end: createdWires=%1 residualRatsnests=%2")
					 .arg(completed)
					 .arg(residualRatsnests));
	}
	m_phaseStats.completionMs = takePhaseMs();

	// PRIME INVARIANT audit: the routed result must not connect nets that
	// the schematic keeps separate. Any violation is our bug - roll the
	// entire autoroute back rather than ship a wrong circuit.
	// PRIME INVARIANT audit: bus-ownership prevents shorts by construction;
	// this is the independent belt-and-braces check (breadboard-only bus
	// union-find, verified to report 0 on valid routes). Any violation is
	// our bug - roll the whole autoroute back rather than ship a wrong
	// circuit.
	{
		QStringList violations;
		if (!verifySchematicConformance(violations))
		{
			logAutoroute(QString("SCHEMATIC CONFORMANCE FAILED (%1 shorts):\n%2")
							 .arg(violations.count())
							 .arg(violations.join('\n')));
			undoStack->endMacro();
			undoStack->undo();
			flushAutorouteLog();
			QMessageBox messageBox(QMessageBox::Critical,
								   QObject::tr("Fritzing"),
								   QObject::tr("Autoroute created connections that do not exist in the schematic and was rolled back."));
			messageBox.setDetailedText(violations.join('\n'));
			messageBox.exec();
			return;
		}
		logAutoroute("schematic conformance verified: no breadboard shorts between schematic nets");
	}

	logAutoroute(QString("undo transaction after routing: count=%1 index=%2")
				 .arg(undoStack->count())
				 .arg(undoStack->index()));
	undoStack->endMacro();
	m_phaseStats.cleanupMs = takePhaseMs();
	logAutoroute(QString("undo transaction end: count=%1 index=%2 delta=%3")
				 .arg(undoStack->count())
				 .arg(undoStack->index())
				 .arg(undoStack->count() - undoCountBefore));
	m_lastRoutingScore.failedNets = residualRatsnests;
	logAutoroute(QString("phase-summary: %1 total=%2ms score={%3}")
				 .arg(m_phaseStats.toString())
				 .arg(elapsed.elapsed())
				 .arg(m_lastRoutingScore.toString()));
	logAutoroute(QString("benchmark: %1 elapsedMs=%2")
				 .arg(m_lastRoutingScore.toString())
				 .arg(elapsed.elapsed()));

	if (residualRatsnests > 0)
	{
		Q_EMIT setProgressMessage2(QObject::tr("Routing incomplete: %1 connection(s) remain.").arg(residualRatsnests));
		logAutoroute(QString("failure: placed=%1 createdWires=%2 residualRatsnests=%3")
					 .arg(placed)
					 .arg(created)
					 .arg(residualRatsnests));
		flushAutorouteLog();
		// Honest guidance: the usual cause is exhausted free bus space.
		QMessageBox::information(nullptr, QObject::tr("Fritzing"),
								 QObject::tr("Autoroute could not complete %1 connection(s).\n\n"
											 "The breadboard's free bus space may be exhausted. "
											 "Adding another breadboard next to the existing one and "
											 "running Autoroute again may allow the circuit to complete.")
									 .arg(residualRatsnests));
	}
	else
	{
		Q_EMIT setProgressMessage2(QObject::tr("Placed %1 part(s), created %2 breadboard jumper wire(s).").arg(placed).arg(created));
		logAutoroute(QString("success: placed=%1 createdWires=%2").arg(placed).arg(created));
	}
	// Diagnostic: any rubber-band leg with more than two points has been
	// reshaped after placement set it to a straight root-to-hole lead.
	Q_FOREACH (QGraphicsItem *graphicsItem, m_sketchWidget->scene()->items())
	{
		auto *connectorItem = dynamic_cast<ConnectorItem *>(graphicsItem);
		if (connectorItem == nullptr || !connectorItem->hasRubberBandLeg())
			continue;
		const QPolygonF leg = connectorItem->sceneAdjustedLeg();
		if (leg.count() <= 2)
			continue;
		QStringList points;
		Q_FOREACH (const QPointF &point, leg)
			points << QString("(%1,%2)").arg(point.x()).arg(point.y());
		logAutoroute(QString("leg audit: %1 points=%2 %3")
						 .arg(connectorSummary(connectorItem))
						 .arg(leg.count())
						 .arg(points.join(" ")));
	}
	logAutoroute("========== breadboard autoroute end ==========");
	flushAutorouteLog();
}

int BreadboardAutorouter::clearPreviousAutorouteWires()
{
	QList<Wire *> generatedWires;
	QList<Wire *> normalBreadboardWires;
	int ratsnestCount = 0;
	Q_FOREACH (QGraphicsItem *graphicsItem, m_sketchWidget->scene()->items())
	{
		auto *wire = dynamic_cast<Wire *>(graphicsItem);
		if (wire == nullptr)
			continue;

		if (wire->getRatsnest())
		{
			ratsnestCount++;
			continue;
		}
		if (!wire->getNormal())
			continue;
		if (wire->viewID() != ViewLayer::BreadboardView)
			continue;

		ConnectorItem *from = wire->connector0() == nullptr ? nullptr : wire->connector0()->firstConnectedToIsh();
		ConnectorItem *to = wire->connector1() == nullptr ? nullptr : wire->connector1()->firstConnectedToIsh();
		const bool touchesBreadboard = connectedBreadboardHoleFor(from) != nullptr
		                            || connectedBreadboardHoleFor(to) != nullptr
		                            || isTargetBreadboardHole(from)
		                            || isTargetBreadboardHole(to);
		if (!touchesBreadboard)
			continue;

		normalBreadboardWires.append(wire);
		if (wire->getAutoroutable() || wire->hasFlag(ViewGeometry::AutoroutableFlag))
			generatedWires.append(wire);
	}

	if (generatedWires.isEmpty() && ratsnestCount == 0)
	{
		generatedWires = normalBreadboardWires;
	}
	else if (!generatedWires.isEmpty() && ratsnestCount == 0)
	{
		Q_FOREACH (Wire *wire, normalBreadboardWires)
		{
			if (!generatedWires.contains(wire))
				generatedWires.append(wire);
		}
	}

	QSet<Wire *> unique;
	QList<Wire *> uniqueGeneratedWires;
	Q_FOREACH (Wire *wire, generatedWires)
	{
		if (wire == nullptr || unique.contains(wire))
			continue;
		unique.insert(wire);
		uniqueGeneratedWires.append(wire);
	}
	generatedWires = uniqueGeneratedWires;

	if (generatedWires.isEmpty())
	{
		logAutoroute(QString("clear previous: none ratsnests=%1 normalBreadboardWires=%2")
		             .arg(ratsnestCount)
		             .arg(normalBreadboardWires.count()));
		return 0;
	}

	auto *parentCommand = new QUndoCommand(QObject::tr("Clear breadboard autoroute"));
	new CleanUpWiresCommand(m_sketchWidget, CleanUpWiresCommand::UndoOnly, parentCommand);
	new CleanUpRatsnestsCommand(m_sketchWidget, CleanUpWiresCommand::UndoOnly, parentCommand);
	m_sketchWidget->makeWiresChangeConnectionCommands(generatedWires, parentCommand);
	Q_FOREACH (Wire *wire, generatedWires)
	{
		m_sketchWidget->makeDeleteItemCommand(wire, BaseCommand::SingleView, parentCommand);
	}
	new CleanUpRatsnestsCommand(m_sketchWidget, CleanUpWiresCommand::RedoOnly, parentCommand);
	new CleanUpWiresCommand(m_sketchWidget, CleanUpWiresCommand::RedoOnly, parentCommand);
	m_sketchWidget->undoStack()->push(parentCommand);

	logAutoroute(QString("clear previous: removed=%1 ratsnests=%2 normalBreadboardWires=%3")
	             .arg(generatedWires.count())
	             .arg(ratsnestCount)
	             .arg(normalBreadboardWires.count()));
	return generatedWires.count();
}

int BreadboardAutorouter::autoplacePartsOnBreadboard()
{
	m_lastPlacementReport.clear();

	QList<ItemBase *> parts;
	m_sketchWidget->collectParts(parts);
	logAutoroute(QString("autoplace: visible parts collected=%1").arg(parts.count()));
	if (parts.isEmpty())
	{
		m_lastPlacementReport = QObject::tr("No breadboard-view parts were found.");
		logAutoroute("autoplace abort: no parts");
		return 0;
	}

	QList<ConnectorItem *> breadboardHoles;
	QList<ItemBase *> targetBreadboards;
	QSet<ConnectorItem *> reservedHoles;
	QList<QRectF> occupiedRects;
	QHash<ConnectorItem *, int> netForConnector;
	QHash<int, QList<ConnectorItem *>> connectorsForNet;
	QHash<ConnectorItem *, ConnectorItem *> placedTargets;
	QHash<ConnectorItem *, ConnectorItem *> newlyPlacedTargets;
	int candidateAttempts = 0;
	int rejectedPinGeometry = 0;
	int rejectedSameBus = 0;
	int rejectedOffBoard = 0;
	int rejectedOverlap = 0;
	int acceptedCandidates = 0;
	int partsWithPlaceablePins = 0;
	int rejectedByPolicy = 0;
	int leftPeripheral = 0;
	int failedBoardFit = 0;
	int placedRigid = 0;
	int placedWithLegs = 0;

	for (int netIndex = 0; netIndex < m_allPartConnectorItems.count(); netIndex++)
	{
		QList<ConnectorItem *> *net = m_allPartConnectorItems.at(netIndex);
		if (net == nullptr)
			continue;
		Q_FOREACH (ConnectorItem *connectorItem, *net)
		{
			if (connectorItem == nullptr)
				continue;
			netForConnector.insert(connectorItem, netIndex);
			connectorsForNet[netIndex].append(connectorItem);
			if (connectorItem->connectorType() == Connector::Female
			    || connectorItem->attachedToItemType() == ModelPart::Wire)
				continue;
			ConnectorItem *breadboardHole = connectedBreadboardHoleFor(connectorItem);
			if (breadboardHole != nullptr && breadboardHole->connectorType() == Connector::Female)
			{
				placedTargets.insert(connectorItem, breadboardHole);
			}
		}
	}

	BreadboardTopology topology;
	topology.discover(m_sketchWidget->scene(), m_sketchWidget->scene()->selectedItems());
	Q_FOREACH (const QString &line, topology.diagnosticLines())
	{
		logAutoroute(line);
	}

	breadboardHoles = topology.holes();
	targetBreadboards = topology.boardItems();
	reservedHoles = topology.reservedHoles();
	QRectF targetBoardBounds = topology.bounds();
	// Union bounds cover the empty gap BETWEEN boards on multi-board
	// sketches; a body is only legal fully inside some single board.
	QVector<QRectF> boardRects;
	Q_FOREACH (const BreadboardTopology::Board &board, topology.boards())
		boardRects.append(board.bounds);
	Q_FOREACH (const QRectF &boardRect, boardRects)
		logAutoroute(QString("board rect: (%1,%2)-(%3,%4)")
						 .arg(boardRect.left()).arg(boardRect.top())
						 .arg(boardRect.right()).arg(boardRect.bottom()));
	auto anyBoardContains = [&boardRects, &targetBoardBounds](const QRectF &bounds) {
		// Fall back to the union when board rects are unavailable so we never
		// reject everything; per-board separation still holds when we have them.
		if (boardRects.isEmpty())
			return targetBoardBounds.contains(bounds);
		Q_FOREACH (const QRectF &boardRect, boardRects)
		{
			if (boardRect.contains(bounds))
				return true;
		}
		return false;
	};
	int targetBoardConnectors = topology.itemConnectorCount();
	int targetSceneConnectors = topology.sceneConnectorCount();

	if (breadboardHoles.isEmpty())
	{
		m_lastPlacementReport = QObject::tr(
									"No target breadboard holes were found.\n"
									"Target breadboard(s): %1\n"
									"Connectors on target breadboard item(s): %2\n"
									"Scene connectors inside target board bounds: %3\n\n"
									"If both connector counts are zero, no scene item owns enough breadboard holes.")
									.arg(targetBreadboards.count())
									.arg(targetBoardConnectors)
									.arg(targetSceneConnectors);
		logAutoroute(QString("autoplace abort: no holes\n%1").arg(m_lastPlacementReport));
		return 0;
	}

	QRectF targetKeepoutBounds = targetBoardBounds.adjusted(-PlacementKeepoutMargin, -PlacementKeepoutMargin, PlacementKeepoutMargin, PlacementKeepoutMargin);

	std::sort(breadboardHoles.begin(), breadboardHoles.end(), [](ConnectorItem *a, ConnectorItem *b)
			  {
		QPointF ap = a->sceneAdjustedTerminalPoint(nullptr);
		QPointF bp = b->sceneAdjustedTerminalPoint(nullptr);
		if (!qFuzzyCompare(ap.y(), bp.y())) return ap.y() < bp.y();
		return ap.x() < bp.x(); });

	QPointF breadboardCenter;
	Q_FOREACH (ConnectorItem *hole, breadboardHoles)
	{
		breadboardCenter += hole->sceneAdjustedTerminalPoint(nullptr);
	}
	breadboardCenter /= breadboardHoles.count();

	// connectorsShareBreadboardBus() rebuilds the bus member list on every
	// call, which is far too slow inside the O(holes^2) candidate loops.
	// Precompute one integer bus id per hole and compare those instead.
	QHash<ConnectorItem *, int> busIdForHole;
	QHash<ConnectorItem *, QPointF> holePositions;
	{
		int busCount = 0;
		Q_FOREACH (ConnectorItem *hole, breadboardHoles)
		{
			holePositions.insert(hole, hole->sceneAdjustedTerminalPoint(nullptr));
			if (busIdForHole.contains(hole))
				continue;
			const int busId = busCount++;
			busIdForHole.insert(hole, busId);
			ItemBase *board = hole->attachedTo();
			QList<ConnectorItem *> busHoles;
			if (board != nullptr && board->busConnectorItems(hole, busHoles))
			{
				Q_FOREACH (ConnectorItem *sibling, busHoles)
					busIdForHole.insert(sibling, busId);
			}
		}
	}
	auto holesShareBus = [&busIdForHole](ConnectorItem *first, ConnectorItem *second) {
		return busIdForHole.value(first, -1) == busIdForHole.value(second, -2);
	};

	QList<ItemBase *> movableParts;
	int skippedNull = 0;
	int skippedInvisible = 0;
	int skippedRatsnest = 0;
	int skippedBreadboard = 0;
	int skippedWire = 0;
	int skippedLocked = 0;
	int skippedAlreadyOnBreadboard = 0;
	Q_FOREACH (ItemBase *part, parts)
	{
		BreadboardPartPolicy::Decision policy = BreadboardPartPolicy::classify(part);
		QString skipReason;
		if (part == nullptr)
		{
			skippedNull++;
			skipReason = "null";
		}
		else if (policy.classification == BreadboardPartPolicy::Classification::Ignore && policy.reason == "not visible")
		{
			skippedInvisible++;
			skipReason = policy.reason;
		}
		else if (policy.classification == BreadboardPartPolicy::Classification::Ignore && policy.reason == "ratsnest")
		{
			skippedRatsnest++;
			skipReason = policy.reason;
		}
		else if (policy.classification == BreadboardPartPolicy::Classification::Ignore && policy.reason == "breadboard")
		{
			skippedBreadboard++;
			skipReason = policy.reason;
		}
		else if (policy.classification == BreadboardPartPolicy::Classification::Ignore && policy.reason == "breadboard decoration")
		{
			skippedBreadboard++;
			skipReason = policy.reason;
		}
		else if (policy.classification == BreadboardPartPolicy::Classification::Ignore && policy.reason == "wire")
		{
			skippedWire++;
			skipReason = policy.reason;
		}
		else if (policy.classification == BreadboardPartPolicy::Classification::Ignore && policy.reason == "move locked")
		{
			skippedLocked++;
			skipReason = policy.reason;
		}
		else if (policy.classification == BreadboardPartPolicy::Classification::Peripheral)
		{
			leftPeripheral++;
			skipReason = QString("peripheral: %1").arg(policy.reason);
		}
		else if (policy.classification != BreadboardPartPolicy::Classification::BoardPlaceable)
		{
			rejectedByPolicy++;
			skipReason = policy.reason;
		}
		else
		{
			bool alreadyOnBreadboard = false;
			Q_FOREACH (ConnectorItem *connectorItem, part->cachedConnectorItems())
			{
				if (connectorItem == nullptr)
					continue;
				if (!isPlaceablePin(connectorItem))
					continue;
				Q_FOREACH (ConnectorItem *connected, connectorItem->connectedToItems())
				{
					if (connected != nullptr && connected->connectorType() == Connector::Female)
					{
						alreadyOnBreadboard = true;
						break;
					}
				}
				if (alreadyOnBreadboard)
					break;
			}
			if (alreadyOnBreadboard)
			{
				skippedAlreadyOnBreadboard++;
				skipReason = "already connected to female connector";
			}
		}

		logAutoroute(QString("part policy: class=%1 reason=%2 pins=%3 bendableLegs=%4 family='%5' taxonomy='%6' package='%7' module=%8 title='%9'")
						 .arg(BreadboardPartPolicy::classificationName(policy.classification))
						 .arg(policy.reason)
						 .arg(policy.placeablePins)
						 .arg(policy.hasBendableLegs ? "yes" : "no")
						 .arg(policy.family)
						 .arg(policy.taxonomy)
						 .arg(policy.package)
						 .arg(policy.moduleID)
						 .arg(policy.title));

		if (skipReason.isEmpty())
		{
			movableParts.append(part);
			logAutoroute(QString("movable part: %1 connectors=%2 placeablePins=%3 bendableLegs=%4 bounds=[%5,%6 %7x%8]")
							 .arg(itemSummary(part))
							 .arg(part->cachedConnectorItems().count())
							 .arg(policy.placeablePins)
							 .arg(policy.hasBendableLegs ? "yes" : "no")
							 .arg(part->sceneBoundingRect().x())
							 .arg(part->sceneBoundingRect().y())
							 .arg(part->sceneBoundingRect().width())
							 .arg(part->sceneBoundingRect().height()));
		}
		else
		{
			logAutoroute(QString("skip part: reason=%1 item=%2").arg(skipReason).arg(itemSummary(part)));
		}
	}
	logAutoroute(QString("movable filter summary: movable=%1 null=%2 invisible=%3 ratsnest=%4 breadboard=%5 wire=%6 locked=%7 alreadyFemale=%8 rejectedByPolicy=%9 leftPeripheral=%10")
					 .arg(movableParts.count())
					 .arg(skippedNull)
					 .arg(skippedInvisible)
					 .arg(skippedRatsnest)
					 .arg(skippedBreadboard)
					 .arg(skippedWire)
					 .arg(skippedLocked)
					 .arg(skippedAlreadyOnBreadboard)
					 .arg(rejectedByPolicy)
					 .arg(leftPeripheral));

	Q_FOREACH (ItemBase *part, parts)
	{
		if (part == nullptr)
			continue;
		if (!part->isEverVisible())
			continue;
		ItemBase *chief = part->layerKinChief();
		if (isBreadboardItem(part) || isBreadboardItem(chief))
			continue;
		if (isBreadboardDecorationItem(part) || isBreadboardDecorationItem(chief))
			continue;
		if (targetBreadboards.contains(part) || targetBreadboards.contains(chief))
			continue;
		if (movableParts.contains(part))
			continue;

		QRectF partBounds = part->sceneBoundingRect().adjusted(-PlacementKeepoutMargin, -PlacementKeepoutMargin, PlacementKeepoutMargin, PlacementKeepoutMargin);
		if (partBounds.intersects(targetKeepoutBounds))
		{
			occupiedRects.append(partBounds);
			logAutoroute(QString("occupied rect: item=%1 bounds=[%2,%3 %4x%5]")
							 .arg(itemSummary(part))
							 .arg(partBounds.x())
							 .arg(partBounds.y())
							 .arg(partBounds.width())
							 .arg(partBounds.height()));
		}
	}
	logAutoroute(QString("occupied rects considered=%1").arg(occupiedRects.count()));

	std::sort(movableParts.begin(), movableParts.end(), [this, &netForConnector, &connectorsForNet](ItemBase *a, ItemBase *b)
			  {
		double aScore = partConnectivityScore(a, netForConnector, connectorsForNet);
		double bScore = partConnectivityScore(b, netForConnector, connectorsForNet);
		if (!qFuzzyCompare(aScore, bScore)) return aScore > bScore;

		double aArea = a == nullptr ? 0 : a->sceneBoundingRect().width() * a->sceneBoundingRect().height();
		double bArea = b == nullptr ? 0 : b->sceneBoundingRect().width() * b->sceneBoundingRect().height();
		if (!qFuzzyCompare(aArea, bArea)) return aArea > bArea;

		QPointF ap = a == nullptr ? QPointF() : a->sceneBoundingRect().center();
		QPointF bp = b == nullptr ? QPointF() : b->sceneBoundingRect().center();
		if (!qFuzzyCompare(ap.x(), bp.x())) return ap.x() < bp.x();
		return ap.y() < bp.y(); });

	QStringList placementOrder;
	Q_FOREACH (ItemBase *part, movableParts)
	{
		placementOrder.append(QString("%1 score=%2")
								  .arg(itemSummary(part))
								  .arg(partConnectivityScore(part, netForConnector, connectorsForNet)));
	}
	logAutoroute(QString("placement order: %1").arg(placementOrder.join(" || ")));

	auto *parentCommand = new QUndoCommand(QObject::tr("Autoplace breadboard parts"));
	// This command is the first child of the outer autoroute macro, so its
	// undo-only cleanup runs after both generated wires and placement
	// connections have been undone. Cleaning inside the routing child leaves
	// stale ratsnests because placement is undone later.
	new CleanUpWiresCommand(m_sketchWidget, CleanUpWiresCommand::UndoOnly, parentCommand);
	new CleanUpRatsnestsCommand(m_sketchWidget, CleanUpWiresCommand::UndoOnly, parentCommand);
	int moved = 0;

	// Prime invariant, placement side: a candidate may only put a pin on a
	// bus that is free or already owned by that pin's net. No-net pins
	// (unused DIP outputs are still outputs!) may only take FREE buses.
	auto conflictsWithPlacedNets = [this, &netForConnector](const QHash<ConnectorItem *, ConnectorItem *> &pinToHole) {
		for (auto candidate = pinToHole.constBegin(); candidate != pinToHole.constEnd(); ++candidate)
		{
			if (candidate.value() == nullptr)
				continue;
			const int busGroup = busGroupFor(candidate.value());
			const int candidateNet = netForConnector.value(candidate.key(), -1);
			if (candidateNet < 0)
			{
				if (busOwner(busGroup) != -1)
					return true;
			}
			else if (!busAvailableFor(busGroup, candidateNet))
			{
				return true;
			}
		}
		return false;
	};

	auto netPlacementCost = [this, &netForConnector, &connectorsForNet, &placedTargets, &breadboardCenter, &holesShareBus, &holePositions](ConnectorItem *pin, ConnectorItem *targetHole) {
		const int netIndex = netForConnector.value(pin, -1);
		if (netIndex < 0 || targetHole == nullptr)
			return 0.0;

		const QPointF targetPos = holePositions.value(targetHole, targetHole->sceneAdjustedTerminalPoint(nullptr));
		double bestDistance = std::numeric_limits<double>::max();
		bool hasPlacedTarget = false;
		bool sharesPlacedBus = false;
		Q_FOREACH (ConnectorItem *other, connectorsForNet.value(netIndex))
		{
			if (other == pin)
				continue;
			ConnectorItem *otherTarget = placedTargets.value(other, nullptr);
			if (otherTarget == nullptr)
				continue;
			hasPlacedTarget = true;
			bestDistance = qMin(bestDistance, manhattanDistance(targetPos, holePositions.value(otherTarget, otherTarget->sceneAdjustedTerminalPoint(nullptr))));
			if (holesShareBus(targetHole, otherTarget))
				sharesPlacedBus = true;
		}

		if (!hasPlacedTarget)
			return manhattanDistance(targetPos, breadboardCenter) * 0.05;
		if (sharesPlacedBus)
			return bestDistance * 0.01;

		// One additional occupied bus implies at least one additional jumper.
		// The tunable penalty keeps that lexicographically more important
		// than geometric terms by default; lowering it makes the router trade
		// jumpers for shorter, straighter component leads.
		return m_jumperPenalty + bestDistance;
	};

	Q_FOREACH (ItemBase *part, movableParts)
	{
		QList<ConnectorItem *> pins;
		Q_FOREACH (ConnectorItem *connectorItem, part->cachedConnectorItems())
		{
			if (connectorItem == nullptr)
				continue;
			if (isPlaceablePin(connectorItem))
				pins.append(connectorItem);
		}
		if (pins.isEmpty())
			continue;
		partsWithPlaceablePins++;
		bool canUseBendableLegPlacement = pins.count() == 2 && allPinsHaveBendableLegs(pins);
		logAutoroute(QString("placement begin: %1 placeablePins=%2 strategy=%3")
						 .arg(itemSummary(part))
						 .arg(pins.count())
						 .arg(canUseBendableLegPlacement ? "rigid-or-bendable-leg" : "rigid"));

		PlacementCandidate best;
		best.item = part;
		best.oldLoc = part->getViewGeometry().loc();

		if (!canUseBendableLegPlacement)
		{
			Q_FOREACH (ConnectorItem *anchorPin, pins)
			{
				QPointF anchorPinPos = anchorPin->sceneAdjustedTerminalPoint(nullptr);
				Q_FOREACH (ConnectorItem *anchorHole, breadboardHoles)
				{
					if (reservedHoles.contains(anchorHole))
						continue;
					candidateAttempts++;

					QPointF offset = anchorHole->sceneAdjustedTerminalPoint(nullptr) - anchorPinPos;
					QSet<ConnectorItem *> candidateReserved;
					QHash<ConnectorItem *, ConnectorItem *> pinToHole;
					bool fits = true;

					Q_FOREACH (ConnectorItem *pin, pins)
					{
						QPointF target = pin->sceneAdjustedTerminalPoint(nullptr) + offset;
						ConnectorItem *nearestHole = nullptr;
						double nearestDistance = HoleMatchTolerance;

						Q_FOREACH (ConnectorItem *hole, breadboardHoles)
						{
							if (reservedHoles.contains(hole) || candidateReserved.contains(hole))
								continue;
							double distance = QLineF(target, hole->sceneAdjustedTerminalPoint(nullptr)).length();
							if (distance <= nearestDistance)
							{
								nearestHole = hole;
								nearestDistance = distance;
							}
						}

						if (nearestHole == nullptr)
						{
							fits = false;
							break;
						}

						candidateReserved.insert(nearestHole);
						pinToHole.insert(pin, nearestHole);
					}

					if (!fits)
					{
						rejectedPinGeometry++;
						continue;
					}

					bool shortsPart = false;
					QList<ConnectorItem *> mappedHoles = pinToHole.values();
					for (int fromIndex = 0; fromIndex < mappedHoles.count(); fromIndex++)
					{
						for (int toIndex = fromIndex + 1; toIndex < mappedHoles.count(); toIndex++)
						{
							if (connectorsShareBreadboardBus(mappedHoles.at(fromIndex), mappedHoles.at(toIndex)))
							{
								shortsPart = true;
								break;
							}
						}
						if (shortsPart)
							break;
					}
					if (shortsPart)
					{
						rejectedSameBus++;
						continue;
					}
					if (conflictsWithPlacedNets(pinToHole))
					{
						rejectedSameBus++;
						continue;
					}

					QRectF movedBounds = part->sceneBoundingRect().translated(offset);
					QRectF movedKeepout = movedBounds.adjusted(-PlacementKeepoutMargin, -PlacementKeepoutMargin, PlacementKeepoutMargin, PlacementKeepoutMargin);
					if (!anyBoardContains(movedBounds))
					{
						rejectedOffBoard++;
						continue;
					}

					bool overlaps = false;
					Q_FOREACH (const QRectF &occupied, occupiedRects)
					{
						if (movedKeepout.intersects(occupied))
						{
							overlaps = true;
							break;
						}
					}
					if (overlaps)
					{
						rejectedOverlap++;
						continue;
					}

					acceptedCandidates++;
					double score = manhattanDistance(movedBounds.center(), breadboardCenter) * 0.15;

					Q_FOREACH (ConnectorItem *pin, pins)
						score += netPlacementCost(pin, pinToHole.value(pin, nullptr));

					if (score < best.score)
					{
						best.newLoc = best.oldLoc + offset;
						best.pinToHole = pinToHole;
						best.pinToLeg.clear();
						best.score = score;
						best.usesLegPlacement = false;
						logAutoroute(QString("placement best update: part=%1 score=%2 offset=(%3,%4) anchorHole=%5")
										 .arg(itemSummary(part))
										 .arg(score)
										 .arg(offset.x())
										 .arg(offset.y())
										 .arg(connectorSummary(anchorHole)));
					}
				}
			}
		}

		if (canUseBendableLegPlacement)
		{
			ConnectorItem *firstPin = pins.at(0);
			ConnectorItem *secondPin = pins.at(1);
			logAutoroute(QString("bendable placement search: %1 pins=[%2 | %3]")
							 .arg(itemSummary(part))
							 .arg(connectorSummary(firstPin))
							 .arg(connectorSummary(secondPin)));

			const QPointF unflippedFirstPinPos = firstPin->sceneAdjustedTerminalPoint(nullptr);
			const QPointF unflippedSecondPinPos = secondPin->sceneAdjustedTerminalPoint(nullptr);
			const double pinPairSpan = QLineF(unflippedFirstPinPos, unflippedSecondPinPos).length();
			const QRectF partBounds = part->sceneBoundingRect();
			const QPointF partCenter = partBounds.center();
			QElapsedTimer searchTimer;
			searchTimer.start();
			qint64 pairCount = 0;
			qint64 shiftIterations = 0;
			qint64 postCutoffEvaluations = 0;
			// Both legs are capped, so viable hole pairs lie within an annulus
			// around the pin spacing; everything else can be rejected on a
			// single distance test before any geometry work.
			const double maxHoleSpan = pinPairSpan + 2.0 * m_maxLegLength;

			// Also search with the pins swapped, so crossed legs can uncross.
			// Prefer a mirror across the pin axis (body stays upright) when
			// the part's breadboard view allows flipping; otherwise fall back
			// to a 180 degree rotation.
			const bool axisMostlyHorizontal =
				qAbs(unflippedSecondPinPos.x() - unflippedFirstPinPos.x())
				>= qAbs(unflippedSecondPinPos.y() - unflippedFirstPinPos.y());
			const Qt::Orientations flipOrientation = axisMostlyHorizontal ? Qt::Horizontal : Qt::Vertical;
			const PinSwap swapMode = part->canFlip(flipOrientation)
				? (axisMostlyHorizontal ? PinSwap::FlipHorizontal : PinSwap::FlipVertical)
				: PinSwap::Rotate180;

			for (int flip = 0; flip <= 1; flip++)
			{
			const PinSwap candidateSwap = flip == 1 ? swapMode : PinSwap::None;
			const QPointF firstPinPos = swappedPoint(unflippedFirstPinPos, candidateSwap, partCenter);
			const QPointF secondPinPos = swappedPoint(unflippedSecondPinPos, candidateSwap, partCenter);
			const QPointF pinAxisDir = pinPairSpan > 0.001
				? QPointF((secondPinPos.x() - firstPinPos.x()) / pinPairSpan,
						  (secondPinPos.y() - firstPinPos.y()) / pinPairSpan)
				: QPointF(1.0, 0.0);

			Q_FOREACH (ConnectorItem *firstHole, breadboardHoles)
			{
				if (reservedHoles.contains(firstHole))
					continue;
				QPointF firstHolePos = holePositions.value(firstHole);
				Q_FOREACH (ConnectorItem *secondHole, breadboardHoles)
				{
					if (firstHole == secondHole)
						continue;
					if (reservedHoles.contains(secondHole))
						continue;
					candidateAttempts++;

					QPointF secondHolePos = holePositions.value(secondHole);
					const double spanDx = secondHolePos.x() - firstHolePos.x();
					const double spanDy = secondHolePos.y() - firstHolePos.y();
					if (spanDx * spanDx + spanDy * spanDy > maxHoleSpan * maxHoleSpan)
					{
						rejectedPinGeometry++;
						continue;
					}

					if (holesShareBus(firstHole, secondHole))
					{
						rejectedSameBus++;
						continue;
					}
					pairCount++;

					// The body need not sit centered between its holes:
					// sliding it along the pin axis lets both leads leave the
					// body forward instead of folding back when the hole pair
					// is narrower than the pin spacing. Leg length varies
					// linearly with the slide along the axis, so the only
					// shifts worth evaluating are the ones that zero each
					// leg's axial component, plus their midpoint.
					const QPointF baseCenter = (firstHolePos + secondHolePos) / 2.0;
					const QPointF baseOffset = baseCenter - partCenter;
					const QPointF baseFirstPin = firstPinPos + baseOffset;
					const QPointF baseSecondPin = secondPinPos + baseOffset;
					const double firstAxial = (firstHolePos.x() - baseFirstPin.x()) * pinAxisDir.x()
											+ (firstHolePos.y() - baseFirstPin.y()) * pinAxisDir.y();
					const double secondAxial = (secondHolePos.x() - baseSecondPin.x()) * pinAxisDir.x()
											 + (secondHolePos.y() - baseSecondPin.y()) * pinAxisDir.y();
					const double axialShifts[] = {(firstAxial + secondAxial) / 2.0, firstAxial, secondAxial};
					for (double axialShift : axialShifts)
					{
					shiftIterations++;
					QPointF desiredCenter = baseCenter
										  + QPointF(pinAxisDir.x() * axialShift, pinAxisDir.y() * axialShift);
					QPointF offset = desiredCenter - partCenter;
					QRectF movedBounds = partBounds.translated(offset);
					QRectF movedKeepout = movedBounds.adjusted(-BendablePlacementKeepoutMargin, -BendablePlacementKeepoutMargin, BendablePlacementKeepoutMargin, BendablePlacementKeepoutMargin);

					if (!anyBoardContains(movedBounds))
					{
						rejectedOffBoard++;
						continue;
					}

					bool overlaps = false;
					Q_FOREACH (const QRectF &occupied, occupiedRects)
					{
						if (movedKeepout.intersects(occupied))
						{
							overlaps = true;
							break;
						}
					}
					if (overlaps)
					{
						rejectedOverlap++;
						continue;
					}

					QPointF movedFirstPin = firstPinPos + offset;
					QPointF movedSecondPin = secondPinPos + offset;
					double firstLegLength = QLineF(movedFirstPin, firstHolePos).length();
					double secondLegLength = QLineF(movedSecondPin, secondHolePos).length();
					if (firstLegLength > m_maxLegLength || secondLegLength > m_maxLegLength)
					{
						rejectedPinGeometry++;
						continue;
					}

					acceptedCandidates++;
					double score = manhattanDistance(movedBounds.center(), breadboardCenter) * 0.15
								 + (firstLegLength + secondLegLength) * m_leadLengthWeight;

					// Straight leads only look straight when they leave along
					// the body axis. Penalize perpendicular drift (diagonal
					// leads) and hole pairs tighter than the pin spacing
					// (leads folding back under the body).
					// pinPairSpan and pinAxisDir are translation-invariant, so
					// reuse the values hoisted outside the candidate loops.
					if (pinPairSpan > 0.001)
					{
						const QPointF firstLegVector = firstHolePos - movedFirstPin;
						const QPointF secondLegVector = secondHolePos - movedSecondPin;
						const double perpendicularDrift =
							qAbs(pinAxisDir.x() * firstLegVector.y() - pinAxisDir.y() * firstLegVector.x())
							+ qAbs(pinAxisDir.x() * secondLegVector.y() - pinAxisDir.y() * secondLegVector.x());
						const double holeSpan = (secondHolePos.x() - firstHolePos.x()) * pinAxisDir.x()
											  + (secondHolePos.y() - firstHolePos.y()) * pinAxisDir.y();
						const double compression = qMax(0.0, pinPairSpan - holeSpan);
						score += perpendicularDrift * m_leadAngleWeight + compression * m_foldbackWeight;
					}

					// Net placement costs only ever add, so a candidate whose
					// geometric score already loses cannot win: skip the
					// expensive conflict and net-cost evaluation entirely.
					if (score >= best.score)
						continue;
					postCutoffEvaluations++;

					QHash<ConnectorItem *, ConnectorItem *> pinToHole;
					pinToHole.insert(firstPin, firstHole);
					pinToHole.insert(secondPin, secondHole);
					if (conflictsWithPlacedNets(pinToHole))
					{
						rejectedSameBus++;
						continue;
					}

					Q_FOREACH (ConnectorItem *pin, pins)
						score += netPlacementCost(pin, pinToHole.value(pin, nullptr));

					if (score < best.score)
					{
						best.newLoc = best.oldLoc + offset;
						best.pinToHole = pinToHole;
						best.pinToLeg.clear();
						best.pinToLeg.insert(firstPin, translatedLegForTarget(firstPin, offset, firstHole, candidateSwap, partCenter));
						best.pinToLeg.insert(secondPin, translatedLegForTarget(secondPin, offset, secondHole, candidateSwap, partCenter));
						best.score = score;
						best.usesLegPlacement = true;
						best.pinSwap = candidateSwap;
						logAutoroute(QString("bendable placement best update: part=%1 score=%2 offset=(%3,%4) holes=[%5 | %6] legLengths=[%7,%8]")
										 .arg(itemSummary(part))
										 .arg(score)
										 .arg(offset.x())
										 .arg(offset.y())
										 .arg(connectorSummary(firstHole))
										 .arg(connectorSummary(secondHole))
										 .arg(firstLegLength)
										 .arg(secondLegLength));
					}
					} // axialShift loop
				}
			}
			} // flip loop
			logAutoroute(QString("bendable search profile: %1 elapsedMs=%2 pairs=%3 shiftIterations=%4 postCutoffEvaluations=%5")
							 .arg(itemSummary(part))
							 .arg(searchTimer.elapsed())
							 .arg(pairCount)
							 .arg(shiftIterations)
							 .arg(postCutoffEvaluations));
		}

		if (best.pinToHole.isEmpty())
		{
			logAutoroute(QString("placement no candidate: %1").arg(itemSummary(part)));
			failedBoardFit++;
			continue;
		}

		// Transform strictly BEFORE the move and before any pins are bound:
		// transforming a part whose legs are already attached would drag the
		// leg geometry off its assigned holes.
		switch (best.pinSwap)
		{
		case PinSwap::FlipHorizontal:
			new FlipItemCommand(m_sketchWidget, part->id(), Qt::Horizontal, parentCommand);
			logAutoroute(QString("placement flip: %1 mirrored horizontally").arg(itemSummary(part)));
			break;
		case PinSwap::FlipVertical:
			new FlipItemCommand(m_sketchWidget, part->id(), Qt::Vertical, parentCommand);
			logAutoroute(QString("placement flip: %1 mirrored vertically").arg(itemSummary(part)));
			break;
		case PinSwap::Rotate180:
			new RotateItemCommand(m_sketchWidget, part->id(), &FlipRotationDegrees, parentCommand);
			logAutoroute(QString("placement flip: %1 rotated 180").arg(itemSummary(part)));
			break;
		default:
			break;
		}
		ViewGeometry oldGeometry(part->getViewGeometry());
		ViewGeometry newGeometry(part->getViewGeometry());
		newGeometry.setLoc(best.newLoc);
		new MoveItemCommand(m_sketchWidget, part->id(), oldGeometry, newGeometry, false, parentCommand);
		logAutoroute(QString("placement accepted: %1 old=(%2,%3) new=(%4,%5) score=%6")
						 .arg(itemSummary(part))
						 .arg(best.oldLoc.x())
						 .arg(best.oldLoc.y())
						 .arg(best.newLoc.x())
						 .arg(best.newLoc.y())
						 .arg(best.score));

		for (auto it = best.pinToHole.constBegin(); it != best.pinToHole.constEnd(); ++it)
		{
			ConnectorItem *pin = it.key();
			ConnectorItem *hole = it.value();
			if (pin == nullptr || hole == nullptr)
				continue;
			auto *connectionCommand = new ChangeConnectionCommand(m_sketchWidget, BaseCommand::CrossView,
										pin->attachedToID(), pin->connectorSharedID(),
										hole->attachedToID(), hole->connectorSharedID(),
										ViewLayer::specFromID(hole->attachedToViewLayerID()),
										true, parentCommand);
			// Placement already specifies the exact pin and hole. Geometry-driven
			// updates while the part and its legs are moving can detach that pair.
			connectionCommand->setUpdateConnections(false);
			logAutoroute(QString("placement connection: pin=%1 hole=%2 sameBus?=%3")
							 .arg(connectorSummary(pin))
							 .arg(connectorSummary(hole))
							 .arg(connectorsShareBreadboardBus(pin, hole) ? "yes" : "no"));
			reservedHoles.insert(hole);
			placedTargets.insert(pin, hole);
			newlyPlacedTargets.insert(pin, hole);
			// Claim the hole's bus for the pin's net (or exclusively, for a
			// no-net pin) so later placements and routing cannot join it.
			const int placedPinNet = netForConnector.value(pin, -1);
			claimBus(busGroupFor(hole), placedPinNet >= 0 ? placedPinNet : makeNoNetOwnerKey());

			QPolygonF newLeg = best.pinToLeg.value(pin);
			if (!best.usesLegPlacement && pin->hasRubberBandLeg())
			{
				// A rigid move translates the loose sketch's bent leg shape
				// verbatim, so historical bends survive placement. Replace the
				// shape with a direct root-to-hole lead.
				QPolygonF looseLeg = pin->sceneAdjustedLeg();
				if (looseLeg.count() >= 2)
				{
					newLeg.clear();
					newLeg << looseLeg.first() + (best.newLoc - best.oldLoc);
					newLeg << hole->sceneAdjustedTerminalPoint(nullptr);
				}
			}
			if (newLeg.count() >= 2)
			{
				m_componentLeadLength += polylineLength(newLeg);
				QPolygonF oldLeg = pin->sceneAdjustedLeg();
				QPolygonF movedOldLeg;
				QPointF offset = best.newLoc - best.oldLoc;
				Q_FOREACH (QPointF point, oldLeg)
				{
					movedOldLeg << point + offset;
				}
				auto *legCommand = new ChangeLegCommand(m_sketchWidget,
														pin->attachedToID(),
														pin->connectorSharedID(),
														movedOldLeg,
														newLeg,
														false,
														true,
														"breadboard autoroute",
														parentCommand);
				legCommand->setSimple();
				logAutoroute(QString("placement leg: pin=%1 points=%2")
								 .arg(connectorSummary(pin))
								 .arg(newLeg.count()));
			}
		}

		occupiedRects.append(part->sceneBoundingRect().translated(best.newLoc - best.oldLoc).adjusted(-PlacementKeepoutMargin, -PlacementKeepoutMargin, PlacementKeepoutMargin, PlacementKeepoutMargin));
		if (best.usesLegPlacement)
			placedWithLegs++;
		else
			placedRigid++;
		moved++;
	}

	if (moved <= 0)
	{
		delete parentCommand;
		m_lastPlacementReport = QObject::tr(
									"Target breadboard(s): %1\n"
									"Breadboard holes considered: %2\n"
									"Scene connectors inside target board bounds: %3\n"
									"Visible parts: %4\n"
									"Movable parts after filters: %5\n"
									"Movable parts with placeable pins: %6\n"
									"Placement candidates tried: %7\n"
									"Rejected because pins did not line up with free holes: %8\n"
									"Rejected because one part would be shorted on the same breadboard bus: %9\n"
									"Rejected because placement was outside target board: %10\n"
									"Rejected because placement overlapped another part: %11\n"
									"Accepted candidate placements: %12\n"
									"Rejected by policy: %13\n"
									"Left as peripheral: %14\n"
									"Failed board fit: %15\n\n"
									"If pin-geometry rejections dominate, the next implementation needs bendable-leg placement instead of whole-SVG pin alignment.")
									.arg(targetBreadboards.count())
									.arg(breadboardHoles.count())
									.arg(targetSceneConnectors)
									.arg(parts.count())
									.arg(movableParts.count())
									.arg(partsWithPlaceablePins)
									.arg(candidateAttempts)
									.arg(rejectedPinGeometry)
									.arg(rejectedSameBus)
									.arg(rejectedOffBoard)
									.arg(rejectedOverlap)
									.arg(acceptedCandidates)
									.arg(rejectedByPolicy)
									.arg(leftPeripheral)
									.arg(failedBoardFit);
		logAutoroute(QString("autoplace failed:\n%1").arg(m_lastPlacementReport));
		return 0;
	}

	QElapsedTimer execTimer;
	execTimer.start();
	m_sketchWidget->undoStack()->push(parentCommand);
	m_phaseStats.placeExecMs = execTimer.elapsed();
	QStringList connectionFailures;
	if (!verifyPlacedConnections(newlyPlacedTargets, connectionFailures))
	{
		m_lastPlacementReport = QObject::tr("Placed component pins did not attach to their assigned breadboard holes:\n%1")
								.arg(connectionFailures.join('\n'));
		logAutoroute(QString("autoplace connection verification failed:\n%1").arg(m_lastPlacementReport));
		return -1;
	}
	logAutoroute(QString("autoplace counters: moved=%1 placedRigid=%2 placedWithLegs=%3 candidateAttempts=%4 acceptedCandidates=%5 rejectedPinGeometry=%6 rejectedSameBus=%7 rejectedOffBoard=%8 rejectedOverlap=%9 rejectedByPolicy=%10 leftPeripheral=%11 failedBoardFit=%12")
					 .arg(moved)
					 .arg(placedRigid)
					 .arg(placedWithLegs)
					 .arg(candidateAttempts)
					 .arg(acceptedCandidates)
					 .arg(rejectedPinGeometry)
					 .arg(rejectedSameBus)
					 .arg(rejectedOffBoard)
					 .arg(rejectedOverlap)
					 .arg(rejectedByPolicy)
					 .arg(leftPeripheral)
					 .arg(failedBoardFit));
	return moved;
}

bool BreadboardAutorouter::verifyPlacedConnections(const QHash<ConnectorItem *, ConnectorItem *> &placedTargets,
													 QStringList &failures) const
{
	constexpr double EndpointTolerance = 1.0;
	for (auto it = placedTargets.constBegin(); it != placedTargets.constEnd(); ++it)
	{
		ConnectorItem *pin = it.key();
		ConnectorItem *hole = it.value();
		if (pin == nullptr || hole == nullptr)
		{
			failures.append(QObject::tr("Null pin or hole in placement result."));
			continue;
		}

		const bool pinConnected = pin->connectedToItems().contains(hole);
		const bool holeConnected = hole->connectedToItems().contains(pin);
		double endpointDistance = 0.0;
		if (pin->hasRubberBandLeg())
		{
			const QPolygonF leg = pin->sceneAdjustedLeg();
			endpointDistance = leg.isEmpty()
				? std::numeric_limits<double>::infinity()
				: QLineF(leg.last(), hole->sceneAdjustedTerminalPoint(nullptr)).length();
		}

		if (!pinConnected || !holeConnected || endpointDistance > EndpointTolerance)
		{
			failures.append(QObject::tr("%1 -> %2: pinConnected=%3, holeConnected=%4, legEndpointDistance=%5")
							.arg(connectorSummary(pin))
							.arg(connectorSummary(hole))
							.arg(pinConnected ? "yes" : "no")
							.arg(holeConnected ? "yes" : "no")
							.arg(endpointDistance));
		}
		else
		{
			logAutoroute(QString("placement verified: pin=%1 hole=%2 endpointDistance=%3")
							 .arg(connectorSummary(pin))
							 .arg(connectorSummary(hole))
							 .arg(endpointDistance));
		}
	}
	return failures.isEmpty();
}

int BreadboardAutorouter::routeRatsnestDemands(QUndoCommand *parentCommand)
{
	BreadboardTopology topology;
	topology.discover(m_sketchWidget->scene(), m_sketchWidget->scene()->selectedItems());
	const QList<ConnectorItem *> routeHoles = topology.holes();
	QSet<ConnectorItem *> reservedHoles = topology.reservedHoles();
	const HoleBounds holeBounds = boundsForHoles(routeHoles);
	QList<QLineF> plannedSegments;
	QList<Wire *> demands;

	Q_FOREACH (QGraphicsItem *graphicsItem, m_sketchWidget->scene()->items())
	{
		auto *wire = dynamic_cast<Wire *>(graphicsItem);
		if (wire != nullptr && wire->getRatsnest()) demands.append(wire);
	}

	std::sort(demands.begin(), demands.end(), [](Wire *first, Wire *second) {
		if (first == nullptr || second == nullptr) return first != nullptr;
		const double firstLength = QLineF(first->connector0()->sceneAdjustedTerminalPoint(nullptr),
		                                  first->connector1()->sceneAdjustedTerminalPoint(nullptr)).length();
		const double secondLength = QLineF(second->connector0()->sceneAdjustedTerminalPoint(nullptr),
		                                   second->connector1()->sceneAdjustedTerminalPoint(nullptr)).length();
		return firstLength < secondLength;
	});

	int created = 0;
	int failed = 0;
	auto addWire = [&](ConnectorItem *from, ConnectorItem *to) {
		if (from == nullptr || to == nullptr || from == to) return;
		m_sketchWidget->createWire(from, to, generatedWireFlags(), false, BaseCommand::SingleView, parentCommand);
		plannedSegments.append(connectorLine(from, to));
		created++;
	};
	auto applyGraphRoute = [&](const BreadboardRouteGraph::Result &route) {
		Q_FOREACH (const BreadboardRouteGraph::Segment &segment, route.segments)
		{
			addWire(segment.from, segment.to);
			reservedHoles.insert(segment.from);
			reservedHoles.insert(segment.to);
		}
	};
	auto chooseEntry = [&](ConnectorItem *terminal, const QSet<ConnectorItem *> &extraReserved, int ownerKey) {
		ConnectorItem *best = nullptr;
		double bestScore = std::numeric_limits<double>::max();
		Q_FOREACH (ConnectorItem *hole, routeHoles)
		{
			if (hole == nullptr || reservedHoles.contains(hole) || extraReserved.contains(hole)) continue;
			if (hole->connectionsCount() != 0) continue;
			if (!busAvailableFor(busGroupFor(hole), ownerKey)) continue;
			const double score = boardEdgeEntryScore(terminal, hole, holeBounds);
			if (score < bestScore) {
				best = hole;
				bestScore = score;
			}
		}
		return best;
	};

	logAutoroute(QString("ratsnest demands: %1").arg(demands.count()));
	const RouteGraphSession routeSession = RouteGraphSession::build(
		routeHoles,
		[this](ConnectorItem *connectorItem) { return busGroupFor(connectorItem); },
		[this](int busGroup) { return busOwner(busGroup); });
	Q_FOREACH (Wire *demand, demands)
	{
		const int createdBeforeDemand = created;
		ConnectorItem *fromPart = demand->connector0() == nullptr ? nullptr : demand->connector0()->firstConnectedToIsh();
		ConnectorItem *toPart = demand->connector1() == nullptr ? nullptr : demand->connector1()->firstConnectedToIsh();
		ConnectorItem *fromHole = breadboardHoleFor(fromPart);
		ConnectorItem *toHole = breadboardHoleFor(toPart);
		logAutoroute(QString("ratsnest demand begin: from=[%1] fromHole=[%2] to=[%3] toHole=[%4]")
					 .arg(connectorSummary(fromPart))
					 .arg(connectorSummary(fromHole))
					 .arg(connectorSummary(toPart))
					 .arg(connectorSummary(toHole)));

		if (fromPart == nullptr || toPart == nullptr)
		{
			failed++;
			logAutoroute("ratsnest demand failed: missing endpoint");
			continue;
		}

		// The demand's owner key: its schematic net, or a fresh exclusive
		// sentinel if the endpoints are unexpectedly netless.
		int demandNet = m_netForConnector.value(fromPart, INT_MIN);
		if (demandNet == INT_MIN)
			demandNet = m_netForConnector.value(toPart, INT_MIN);
		if (demandNet == INT_MIN)
			demandNet = makeNoNetOwnerKey();

		if (fromHole != nullptr && toHole != nullptr)
		{
			const BreadboardRouteGraphCore::QueryContext routeContext = routeSession.prepare(reservedHoles, plannedSegments, demandNet);
			BreadboardRouteGraph::Result route = routeSession.route(fromHole, toHole, routeContext);
			if (!route.found) {
				failed++;
				logAutoroute(QString("ratsnest demand failed: no board route from=[%1] to=[%2]")
							 .arg(connectorSummary(fromPart), connectorSummary(toPart)));
				continue;
			}
			Q_FOREACH (const BreadboardRouteGraph::Segment &segment, route.segments)
			{
				claimBus(busGroupFor(segment.from), demandNet);
				claimBus(busGroupFor(segment.to), demandNet);
			}
			applyGraphRoute(route);
			logAutoroute(QString("ratsnest demand complete: wires=%1").arg(created - createdBeforeDemand));
			continue;
		}

		if (fromHole == nullptr && toHole == nullptr)
		{
			ConnectorItem *fromEntry = chooseEntry(fromPart, QSet<ConnectorItem *>(), demandNet);
			ConnectorItem *toEntry = nearestFreeBusHole(fromEntry);
			if (toEntry != nullptr && !busAvailableFor(busGroupFor(toEntry), demandNet))
				toEntry = nullptr;
			if (fromEntry == nullptr || toEntry == nullptr) {
				failed++;
				logAutoroute("ratsnest demand failed: no entries for off-board pair");
				continue;
			}
			addWire(fromPart, fromEntry);
			addWire(toPart, toEntry);
			reservedHoles.insert(fromEntry);
			reservedHoles.insert(toEntry);
			claimBus(busGroupFor(fromEntry), demandNet);
			claimBus(busGroupFor(toEntry), demandNet);
			logAutoroute(QString("ratsnest demand complete: wires=%1").arg(created - createdBeforeDemand));
			continue;
		}

		ConnectorItem *terminal = fromHole == nullptr ? fromPart : toPart;
		ConnectorItem *targetHole = fromHole == nullptr ? toHole : fromHole;
		BreadboardPartPolicy::Decision terminalPolicy = BreadboardPartPolicy::classify(terminal->attachedTo()->layerKinChief());
		if (terminalPolicy.classification != BreadboardPartPolicy::Classification::Peripheral) {
			failed++;
			logAutoroute(QString("ratsnest demand failed: board-placeable endpoint has no hole [%1]")
						 .arg(connectorSummary(terminal)));
			continue;
		}

		if (targetHole == nullptr) {
			failed++;
			logAutoroute(QString("ratsnest demand failed: no peripheral target [%1]").arg(connectorSummary(terminal)));
			continue;
		}
		if (!busAvailableFor(busGroupFor(targetHole), demandNet)) {
			failed++;
			logAutoroute(QString("ratsnest demand failed: peripheral target bus owned by another net [%1]").arg(connectorSummary(targetHole)));
			continue;
		}
		addWire(terminal, targetHole);
		reservedHoles.insert(targetHole);
		claimBus(busGroupFor(targetHole), demandNet);
		logAutoroute(QString("ratsnest demand complete: wires=%1").arg(created - createdBeforeDemand));
	}

	double jumperLength = 0.0;
	Q_FOREACH (const QLineF &segment, plannedSegments) jumperLength += segment.length();
	m_lastRoutingScore.failedNets = failed;
	m_lastRoutingScore.jumperCount = created;
	m_lastRoutingScore.jumperLength = jumperLength;
	m_lastRoutingScore.componentLeadLength = m_componentLeadLength;
	logAutoroute(QString("ratsnest route result: demands=%1 failed=%2 created=%3 length=%4")
				 .arg(demands.count()).arg(failed).arg(created).arg(jumperLength));
	return created;
}

// One net-routing pass over the sketch. The pass owns the state every phase
// shares (route graph session, reserved holes, planned wire segments, score
// counters); routeCollectedNets() is reduced to building the pass and driving
// nets through its phases in most-constrained-first order.
struct BreadboardAutorouter::NetRoutingPass
{
	BreadboardAutorouter *self = nullptr;
	QUndoCommand *parentCommand = nullptr;

	QList<ConnectorItem *> routeHoles;
	QSet<ConnectorItem *> reservedHoles;
	HoleBounds holeBounds;
	RouteGraphSession session;
	QList<QLineF> plannedSegments;
	QSet<int> failedNetIndices;
	int created = 0;
	int wiredPeripheral = 0;
	int allocatedPeripheralLanes = 0;
	double peripheralLeadLength = 0.0;

	// Working data for the net currently being routed.
	int netIndex = -1;
	QList<ConnectorItem *> breadboardAnchors;
	QList<ConnectorItem *> offBoardTerminals;
	QList<QList<ConnectorItem *> > groups;

	NetRoutingPass(BreadboardAutorouter *router, QUndoCommand *command)
		: self(router)
		, parentCommand(command)
	{
		BreadboardTopology topology;
		topology.discover(self->m_sketchWidget->scene(), self->m_sketchWidget->scene()->selectedItems());
		routeHoles = topology.holes();
		reservedHoles = topology.reservedHoles();
		holeBounds = boundsForHoles(routeHoles);
		session = RouteGraphSession::build(
			routeHoles,
			[this](ConnectorItem *connectorItem) { return self->busGroupFor(connectorItem); },
			[this](int busGroup) { return self->busOwner(busGroup); });

		const BreadboardRouteGraph::Options activeOptions = BreadboardRouteGraph::Options::fromEnvironment();
		self->logAutoroute(QString("route options: maxJumperLength=%1 candidatesPerBusPair=%2 crossingPenalty=%3 overlapPenalty=%4")
						   .arg(activeOptions.maxJumperLength)
						   .arg(activeOptions.candidatesPerBusPair)
						   .arg(activeOptions.crossingPenalty)
						   .arg(activeOptions.overlapPenalty));
	}

	// Wire a lead from an off-board terminal to a board hole, with all the
	// bookkeeping a peripheral lead requires (lead-length accounting so it
	// is not counted as a board jumper, reservation, bus claim).
	void addPeripheralLead(ConnectorItem *terminal, ConnectorItem *entry)
	{
		self->m_sketchWidget->createWire(terminal, entry, generatedWireFlags(), false, BaseCommand::SingleView, parentCommand);
		const QLineF lead = connectorLine(terminal, entry);
		plannedSegments.append(lead);
		peripheralLeadLength += lead.length();
		reservedHoles.insert(entry);
		self->claimBus(self->busGroupFor(entry), netIndex);
		created++;
		wiredPeripheral++;
	}

	// Wire one board jumper segment produced by the route graph, claiming
	// both end buses for the net (prime invariant bookkeeping).
	void addGraphWire(const BreadboardRouteGraph::Segment &segment)
	{
		self->m_sketchWidget->createWire(segment.from, segment.to, generatedWireFlags(), false, BaseCommand::SingleView, parentCommand);
		plannedSegments.append(connectorLine(segment.from, segment.to));
		reservedHoles.insert(segment.from);
		reservedHoles.insert(segment.to);
		self->claimBus(self->busGroupFor(segment.from), netIndex);
		self->claimBus(self->busGroupFor(segment.to), netIndex);
		created++;
	}

	// Route nets hardest-first so constrained nets grab scarce buses before
	// easy nets consume them. Difficulty is precomputed: the comparator
	// would otherwise re-run subnet grouping O(n log n) times.
	QList<int> netOrderMostConstrainedFirst() const
	{
		QList<int> routeOrder;
		for (int index = 0; index < self->m_allPartConnectorItems.count(); index++)
			routeOrder.append(index);

		QHash<int, double> difficultyForNet;
		Q_FOREACH (int index, routeOrder)
		{
			QList<ConnectorItem *> *net = self->m_allPartConnectorItems.value(index);
			if (net == nullptr)
			{
				difficultyForNet.insert(index, 0.0);
				continue;
			}
			const QList<ConnectorItem *> candidates = self->routingCandidatesForSubnet(*net);
			const int groupCount = self->collectCandidateGroups(candidates).count();
			QRectF bounds;
			Q_FOREACH (ConnectorItem *candidate, candidates) {
				if (candidate == nullptr) continue;
				const QRectF point(candidate->sceneAdjustedTerminalPoint(nullptr), QSizeF(1.0, 1.0));
				bounds = bounds.isNull() ? point : bounds | point;
			}
			difficultyForNet.insert(index, groupCount * 100000.0 + candidates.count() * 1000.0 + bounds.width() + bounds.height());
		}
		std::sort(routeOrder.begin(), routeOrder.end(), [&difficultyForNet](int firstIndex, int secondIndex) {
			return difficultyForNet.value(firstIndex) > difficultyForNet.value(secondIndex);
		});
		return routeOrder;
	}

	// Split the net's connectors into breadboard anchors (pins already in
	// holes) and off-board peripheral terminals that need jumper leads.
	void collectTerminals(const QList<ConnectorItem *> &net)
	{
		breadboardAnchors.clear();
		offBoardTerminals.clear();
		Q_FOREACH (ConnectorItem *connectorItem, net)
		{
			if (connectorItem == nullptr)
				continue;
			ItemBase *itemBase = connectorItem->attachedTo();
			if (itemBase == nullptr)
				continue;
			if (!itemBase->isEverVisible())
				continue;
			if (itemBase->getRatsnest())
				continue;
			if (connectorItem->attachedToItemType() == ModelPart::Wire)
				continue;
			if (!self->isPlaceablePin(connectorItem) && connectorItem->connectorType() != Connector::Female)
				continue;

			ConnectorItem *connectedHole = self->connectedBreadboardHoleFor(connectorItem);
			if (connectedHole != nullptr)
			{
				if (!breadboardAnchors.contains(connectedHole))
					breadboardAnchors.append(connectedHole);
				continue;
			}

			// Female sockets on peripheral parts (breakout headers) are
			// legitimate jumper terminals; only breadboard holes are excluded
			// (they became anchors above via connectedBreadboardHoleFor).
			BreadboardPartPolicy::Decision policy = BreadboardPartPolicy::classify(itemBase->layerKinChief());
			if (policy.classification == BreadboardPartPolicy::Classification::Peripheral && !offBoardTerminals.contains(connectorItem))
			{
				offBoardTerminals.append(connectorItem);
				self->logAutoroute(QString("route peripheral terminal: net=%1 terminal=%2 class=%3 reason=%4")
								   .arg(netIndex)
								   .arg(self->connectorSummary(connectorItem))
								   .arg(BreadboardPartPolicy::classificationName(policy.classification))
								   .arg(policy.reason));
			}
			else if (policy.classification == BreadboardPartPolicy::Classification::BoardPlaceable && connectorItem->connectorType() != Connector::Female)
			{
				self->logAutoroute(QString("route skip board-placeable offboard terminal: net=%1 terminal=%2 reason=not a peripheral")
								   .arg(netIndex)
								   .arg(self->connectorSummary(connectorItem)));
			}
		}
	}

	// A net with NO board presence yet (all terminals off-board, e.g. a pot
	// wired straight to a jack) gets a "lane": one board entry hole per
	// terminal, chosen near the board edge facing it, plus graph routes
	// joining those entries into one electrical group. All-or-nothing: the
	// lane is only wired when every terminal found an entry and every entry
	// pair found a route.
	void wirePeripheralLane()
	{
		if (!breadboardAnchors.isEmpty() || offBoardTerminals.count() <= 1)
			return;

		QList<ConnectorItem *> terminalEntries;
		QSet<ConnectorItem *> usedEntries;
		QList<QLineF> entryLeadSegments = plannedSegments;
		bool entriesReady = true;

		Q_FOREACH (ConnectorItem *terminal, offBoardTerminals)
		{
			ConnectorItem *bestEntry = nullptr;
			double bestEntryScore = std::numeric_limits<double>::max();
			Q_FOREACH (ConnectorItem *entry, routeHoles)
			{
				if (entry == nullptr || reservedHoles.contains(entry) || usedEntries.contains(entry))
					continue;
				if (entry->connectionsCount() > 0)
					continue;
				if (!self->busAvailableFor(self->busGroupFor(entry), netIndex))
					continue;
				const double score = boardEdgeEntryScore(terminal, entry, holeBounds)
				                   + leadCongestionPenalty(terminal, entry, entryLeadSegments);
				if (score < bestEntryScore)
				{
					bestEntry = entry;
					bestEntryScore = score;
				}
			}
			if (bestEntry == nullptr)
			{
				entriesReady = false;
				failedNetIndices.insert(netIndex);
				self->logAutoroute(QString("route peripheral entry skipped: net=%1 terminal=%2 no free edge entry")
								   .arg(netIndex)
								   .arg(self->connectorSummary(terminal)));
				break;
			}
			terminalEntries.append(bestEntry);
			usedEntries.insert(bestEntry);
			entryLeadSegments.append(connectorLine(terminal, bestEntry));
			self->logAutoroute(QString("route peripheral entry: net=%1 terminal=%2 entry=%3 score=%4")
							   .arg(netIndex)
							   .arg(self->connectorSummary(terminal))
							   .arg(self->connectorSummary(bestEntry))
							   .arg(bestEntryScore));
		}

		QList<BreadboardRouteGraph::Result> entryRoutes;
		if (entriesReady)
		{
			QSet<ConnectorItem *> temporaryReserved = reservedHoles;
			QList<QLineF> entryPlanningSegments = plannedSegments;
			Q_FOREACH (ConnectorItem *entry, terminalEntries)
			{
				temporaryReserved.insert(entry);
			}

			QList<ConnectorItem *> connectedEntries;
			if (!terminalEntries.isEmpty())
				connectedEntries.append(terminalEntries.first());

			for (int targetIndex = 1; targetIndex < terminalEntries.count(); targetIndex++)
			{
				ConnectorItem *targetEntry = terminalEntries.at(targetIndex);
				BreadboardRouteGraph::Result bestRoute;
				const BreadboardRouteGraphCore::QueryContext entryContext = session.prepare(temporaryReserved, entryPlanningSegments, netIndex);
				Q_FOREACH (ConnectorItem *connectedEntry, connectedEntries)
				{
					BreadboardRouteGraph::Result route = session.route(connectedEntry, targetEntry, entryContext);
					if (!route.found)
						continue;
					if (routeIsBetter(route, bestRoute))
					{
						bestRoute = route;
					}
				}
				if (!bestRoute.found)
				{
					entriesReady = false;
					failedNetIndices.insert(netIndex);
					self->logAutoroute(QString("route peripheral entries skipped: net=%1 entry=%2 no graph route")
									   .arg(netIndex)
									   .arg(self->connectorSummary(targetEntry)));
					break;
				}
				entryRoutes.append(bestRoute);
				Q_FOREACH (const BreadboardRouteGraph::Segment &segment, bestRoute.segments) {
					entryPlanningSegments.append(connectorLine(segment.from, segment.to));
					temporaryReserved.insert(segment.from);
					temporaryReserved.insert(segment.to);
				}
				connectedEntries.append(targetEntry);
			}
		}

		if (entriesReady && terminalEntries.count() == offBoardTerminals.count())
		{
			allocatedPeripheralLanes++;
			self->logAutoroute(QString("route peripheral entries: net=%1 terminals=%2 routes=%3")
							   .arg(netIndex)
							   .arg(offBoardTerminals.count())
							   .arg(entryRoutes.count()));
			for (int terminalIndex = 0; terminalIndex < offBoardTerminals.count(); terminalIndex++)
			{
				ConnectorItem *terminal = offBoardTerminals.at(terminalIndex);
				ConnectorItem *target = terminalEntries.at(terminalIndex);
				if (terminal == nullptr || target == nullptr)
					continue;
				addPeripheralLead(terminal, target);
			}
			Q_FOREACH (const BreadboardRouteGraph::Result &route, entryRoutes)
			{
				Q_FOREACH (const BreadboardRouteGraph::Segment &segment, route.segments)
				{
					if (segment.from == nullptr || segment.to == nullptr || segment.from == segment.to)
						continue;
					addGraphWire(segment);
				}
			}
			breadboardAnchors.append(terminalEntries.first());
			offBoardTerminals.clear();
		}
	}

	// Bridge each remaining off-board terminal to the net's existing board
	// presence: pick the (entry hole, anchor) pair with the best combined
	// lead + graph-route score, wire the lead, then wire the route.
	void bridgeTerminalsToAnchors()
	{
		if (breadboardAnchors.isEmpty() || offBoardTerminals.isEmpty())
			return;

		QSet<ConnectorItem *> usedBridgeTargets;
		Q_FOREACH (ConnectorItem *terminal, offBoardTerminals)
		{
			ConnectorItem *bestAnchor = nullptr;
			ConnectorItem *bestEntry = nullptr;
			BreadboardRouteGraph::Result bestRoute;
			BreadboardRoutingScore bestBridgeScore;
			bool haveBridgeScore = false;
			const BreadboardRouteGraphCore::QueryContext bridgeContext = session.prepare(reservedHoles, plannedSegments, netIndex);
			// One Dijkstra per anchor; each of the ~holes entries below is
			// then a constant-time extract instead of its own search.
			QList<BreadboardRouteGraphCore::MultiResult> anchorRoutes;
			Q_FOREACH (ConnectorItem *anchor, breadboardAnchors)
				anchorRoutes.append(session.routeFrom(anchor, bridgeContext));

			Q_FOREACH (ConnectorItem *entry, routeHoles)
			{
				if (entry == nullptr || reservedHoles.contains(entry) || usedBridgeTargets.contains(entry))
					continue;
				if (entry->connectionsCount() > 0)
					continue;
				if (!self->busAvailableFor(self->busGroupFor(entry), netIndex))
					continue;
				const double entryScore = boardEdgeEntryScore(terminal, entry, holeBounds)
				                        + leadCongestionPenalty(terminal, entry, plannedSegments);
				if (entryScore == std::numeric_limits<double>::max())
					continue;

				for (int anchorIndex = 0; anchorIndex < breadboardAnchors.count(); anchorIndex++)
				{
					ConnectorItem *anchor = breadboardAnchors.at(anchorIndex);
					if (anchor == nullptr)
						continue;
					BreadboardRouteGraph::Result route = session.extract(anchorRoutes.at(anchorIndex), entry);
					if (!route.found)
						continue;

					BreadboardRoutingScore score = route.score;
					score.jumperCount++;
					score.jumperLength += connectorLine(terminal, entry).length();
					score.congestion += entryScore;
					if (!haveBridgeScore || score < bestBridgeScore)
					{
						bestAnchor = anchor;
						bestEntry = entry;
						bestRoute = route;
						bestBridgeScore = score;
						haveBridgeScore = true;
					}
				}
			}

			if (bestEntry == nullptr || !bestRoute.found)
			{
				failedNetIndices.insert(netIndex);
				self->logAutoroute(QString("route bridge skipped: net=%1 terminal=%2 no breadboard target")
								   .arg(netIndex)
								   .arg(self->connectorSummary(terminal)));
				continue;
			}

			self->logAutoroute(QString("route bridge: net=%1 terminal=%2 anchor=%3 entry=%4 segments=%5 score=%6")
							   .arg(netIndex)
							   .arg(self->connectorSummary(terminal))
							   .arg(self->connectorSummary(bestAnchor))
							   .arg(self->connectorSummary(bestEntry))
							   .arg(bestRoute.segments.count())
							   .arg(bestBridgeScore.toString()));
			addPeripheralLead(terminal, bestEntry);
			usedBridgeTargets.insert(bestEntry);

			Q_FOREACH (const BreadboardRouteGraph::Segment &segment, bestRoute.segments)
			{
				if (segment.from == nullptr || segment.to == nullptr || segment.from == segment.to)
					continue;
				addGraphWire(segment);
				self->logAutoroute(QString("route bridge graph wire: net=%1 from=%2 to=%3 cost=%4")
								   .arg(netIndex)
								   .arg(self->connectorSummary(segment.from))
								   .arg(self->connectorSummary(segment.to))
								   .arg(segment.cost));
			}
		}
	}

	// Merge the net's electrically separate groups with graph-routed
	// jumpers, always joining the cheapest available pair first, until one
	// group remains or no legal route exists.
	void mergeSubnetGroups()
	{
		if (groups.count() < 2)
			return;

		while (groups.count() > 1)
		{
			int bestFromSubnet = -1;
			int bestToSubnet = -1;
			BreadboardRouteGraph::Result bestRoute;
			BreadboardRoutingScore bestRoutingScore;
			double bestTieBreak = std::numeric_limits<double>::max();
			bool haveBestScore = false;
			const BreadboardRouteGraphCore::QueryContext mergeContext = session.prepare(reservedHoles, plannedSegments, netIndex);

			for (int fromSubnet = 0; fromSubnet < groups.count(); fromSubnet++)
			{
				QList<ConnectorItem *> fromCandidates = groups.at(fromSubnet);
				if (fromCandidates.isEmpty())
					continue;

				for (int toSubnet = fromSubnet + 1; toSubnet < groups.count(); toSubnet++)
				{
					QList<ConnectorItem *> toCandidates = groups.at(toSubnet);
					if (toCandidates.isEmpty())
						continue;

					Q_FOREACH (ConnectorItem *fromCandidate, fromCandidates)
					{
						Q_FOREACH (ConnectorItem *toCandidate, toCandidates)
						{
							if (fromCandidate == nullptr || toCandidate == nullptr || fromCandidate == toCandidate)
								continue;
							BreadboardRouteGraph::Result route = session.route(fromCandidate, toCandidate, mergeContext);
							if (!route.found)
								continue;
							const double tieBreak = self->routeScore(fromCandidate, toCandidate);
							if (!haveBestScore || route.score < bestRoutingScore
							    || (route.score == bestRoutingScore && tieBreak < bestTieBreak))
							{
								bestRoute = route;
								bestRoutingScore = route.score;
								bestTieBreak = tieBreak;
								haveBestScore = true;
								bestFromSubnet = fromSubnet;
								bestToSubnet = toSubnet;
							}
						}
					}
				}
			}

			if (!bestRoute.found)
			{
				failedNetIndices.insert(netIndex);
				self->logAutoroute(QString("route graph failed: net=%1 groups=%2 buses=%3 edges=%4")
								   .arg(netIndex)
								   .arg(groups.count())
								   .arg(session.core->busCount())
								   .arg(session.core->edgeCount()));
				return;
			}

			self->logAutoroute(QString("route choose: net=%1 fromGroup=%2 toGroup=%3 segments=%4 score=%5")
							   .arg(netIndex)
							   .arg(bestFromSubnet)
							   .arg(bestToSubnet)
							   .arg(bestRoute.segments.count())
							   .arg(bestRoutingScore.toString()));
			Q_FOREACH (const BreadboardRouteGraph::Segment &segment, bestRoute.segments)
			{
				if (segment.from == nullptr || segment.to == nullptr || segment.from == segment.to)
					continue;
				addGraphWire(segment);
				self->logAutoroute(QString("route graph wire: net=%1 from=%2 to=%3 cost=%4")
								   .arg(netIndex)
								   .arg(self->connectorSummary(segment.from))
								   .arg(self->connectorSummary(segment.to))
								   .arg(segment.cost));
			}

			groups[bestFromSubnet].append(groups.at(bestToSubnet));
			groups.removeAt(bestToSubnet);
		}
	}

	// Route one net: log its electrical groups, split terminals into
	// anchors and off-board peripherals, then run the three wiring phases.
	void routeNet(int index, QList<ConnectorItem *> *net)
	{
		netIndex = index;
		const QList<ConnectorItem *> candidates = self->routingCandidatesForSubnet(*net);
		groups = self->collectCandidateGroups(candidates);
		self->logAutoroute(QString("route net %1: netConnectors=%2 candidates=%3 groups=%4")
						   .arg(netIndex)
						   .arg(net->count())
						   .arg(candidates.count())
						   .arg(groups.count()));
		for (int groupIndex = 0; groupIndex < groups.count(); groupIndex++)
		{
			QStringList connectorLines;
			const QList<ConnectorItem *> group = groups.at(groupIndex);
			for (int connectorIndex = 0; connectorIndex < group.count() && connectorIndex < 6; connectorIndex++)
				connectorLines.append(self->connectorSummary(group.at(connectorIndex)));
			self->logAutoroute(QString("route net %1 group %2 size=%3 sample=[%4]")
							   .arg(netIndex)
							   .arg(groupIndex)
							   .arg(group.count())
							   .arg(connectorLines.join(" | ")));
		}

		collectTerminals(*net);
		wirePeripheralLane();
		bridgeTerminalsToAnchors();
		mergeSubnetGroups();
	}

	// Fill in the run's score and counters once every net is done.
	void finish()
	{
		double jumperLength = 0.0;
		Q_FOREACH (const QLineF &segment, plannedSegments) jumperLength += segment.length();
		jumperLength = qMax(0.0, jumperLength - peripheralLeadLength);
		self->m_lastRoutingScore.failedNets = failedNetIndices.count();
		self->m_lastRoutingScore.jumperCount = created - wiredPeripheral;
		self->m_lastRoutingScore.jumperLength = jumperLength;
		self->m_lastRoutingScore.componentLeadLength = self->m_componentLeadLength;
		self->logAutoroute(QString("route counters: totalWires=%1 boardJumpers=%2 wiredPeripheral=%3 peripheralLeadLength=%4 allocatedPeripheralLanes=%5 failedNets=%6")
						   .arg(created)
						   .arg(created - wiredPeripheral)
						   .arg(wiredPeripheral)
						   .arg(peripheralLeadLength)
						   .arg(allocatedPeripheralLanes)
						   .arg(failedNetIndices.count()));
	}
};

int BreadboardAutorouter::routeCollectedNets(QUndoCommand *parentCommand)
{
	NetRoutingPass pass(this, parentCommand);

	const QList<int> routeOrder = pass.netOrderMostConstrainedFirst();
	QStringList routeOrderText;
	Q_FOREACH (int netIndex, routeOrder) routeOrderText.append(QString::number(netIndex));
	logAutoroute(QString("route order (most constrained first): %1").arg(routeOrderText.join(",")));

	for (int orderIndex = 0; orderIndex < routeOrder.count(); orderIndex++)
	{
		Q_EMIT setProgressValue(orderIndex);
		const int netIndex = routeOrder.at(orderIndex);
		QList<ConnectorItem *> *net = m_allPartConnectorItems.at(netIndex);
		if (net == nullptr)
			continue;
		pass.routeNet(netIndex, net);
	}

	pass.finish();
	return pass.created;
}

QList<QList<ConnectorItem *>> BreadboardAutorouter::collectCandidateGroups(const QList<ConnectorItem *> &candidates) const
{
	QList<ConnectorItem *> validCandidates;
	Q_FOREACH (ConnectorItem *candidate, candidates)
	{
		if (candidate != nullptr && !validCandidates.contains(candidate))
			validCandidates.append(candidate);
	}

	QVector<int> parents(validCandidates.count());
	for (int i = 0; i < parents.count(); i++) parents[i] = i;
	auto findRoot = [&parents](int value) {
		int root = value;
		while (parents[root] != root) root = parents[root];
		while (parents[value] != value) {
			const int next = parents[value];
			parents[value] = root;
			value = next;
		}
		return root;
	};
	auto unite = [&parents, &findRoot](int first, int second) {
		const int firstRoot = findRoot(first);
		const int secondRoot = findRoot(second);
		if (firstRoot != secondRoot) parents[secondRoot] = firstRoot;
	};

	// Breadboard connectivity is deliberately narrower than Fritzing's global
	// equal-potential graph. A ratsnest describes intent, not copper. Only a
	// discovered breadboard bus or a real Breadboard View wire joins groups.
	for (int first = 0; first < validCandidates.count(); first++)
	{
		for (int second = first + 1; second < validCandidates.count(); second++)
		{
			if (connectorsShareBreadboardBus(validCandidates.at(first), validCandidates.at(second)))
				unite(first, second);
		}
	}

	using WireEnds = QPair<ConnectorItem *, ConnectorItem *>;
	Q_FOREACH (const WireEnds &wireEnds, normalBreadboardWireEnds())
	{
		ConnectorItem *from = wireEnds.first;
		ConnectorItem *to = wireEnds.second;

		for (int first = 0; first < validCandidates.count(); first++)
		{
			if (!connectorsShareBreadboardBus(validCandidates.at(first), from))
				continue;
			for (int second = 0; second < validCandidates.count(); second++)
			{
				if (connectorsShareBreadboardBus(validCandidates.at(second), to))
					unite(first, second);
			}
		}
	}

	QHash<int, QList<ConnectorItem *>> groupsByRoot;
	for (int i = 0; i < validCandidates.count(); i++)
		groupsByRoot[findRoot(i)].append(validCandidates.at(i));

	return groupsByRoot.values();
}

int BreadboardAutorouter::countUnresolvedNets() const
{
	int residualRatsnests = 0;
	Q_FOREACH (QGraphicsItem *graphicsItem, m_sketchWidget->scene()->items())
	{
		auto *wire = dynamic_cast<Wire *>(graphicsItem);
		if (wire == nullptr || !wire->getRatsnest()) continue;
		residualRatsnests++;
		ConnectorItem *from = wire->connector0() == nullptr ? nullptr : wire->connector0()->firstConnectedToIsh();
		ConnectorItem *to = wire->connector1() == nullptr ? nullptr : wire->connector1()->firstConnectedToIsh();
		logAutoroute(QString("validation residual ratsnest: %1 from=[%2] to=[%3]")
					 .arg(itemSummary(wire))
					 .arg(connectorSummary(from))
					 .arg(connectorSummary(to)));
	}
	return residualRatsnests;
}

bool BreadboardAutorouter::isBreadboardItem(ItemBase *itemBase) const
{
	return BreadboardTopology::isBreadboardItem(itemBase);
}

bool BreadboardAutorouter::isBreadboardDecorationItem(ItemBase *itemBase) const
{
	return BreadboardTopology::isBreadboardDecorationItem(itemBase);
}

bool BreadboardAutorouter::isMovableBreadboardPart(ItemBase *itemBase) const
{
	BreadboardPartPolicy::Decision policy = BreadboardPartPolicy::classify(itemBase);
	return policy.classification == BreadboardPartPolicy::Classification::BoardPlaceable;
}

bool BreadboardAutorouter::isPlaceablePin(ConnectorItem *connectorItem) const
{
	if (connectorItem == nullptr)
		return false;
	Connector::ConnectorType connectorType = connectorItem->connectorType();
	return connectorType == Connector::Male || connectorType == Connector::Pad || connectorItem->isHybrid();
}

bool BreadboardAutorouter::isTargetBreadboardHole(ConnectorItem *connectorItem) const
{
	return BreadboardTopology::isTargetBreadboardHole(connectorItem);
}

bool BreadboardAutorouter::connectorsShareBreadboardBus(ConnectorItem *first, ConnectorItem *second) const
{
	if (first == nullptr || second == nullptr)
		return false;
	if (first == second)
		return true;
	return busGroupFor(first) == busGroupFor(second);
}

int BreadboardAutorouter::busGroupFor(ConnectorItem *connectorItem) const
{
	auto found = m_busGroupForConnector.constFind(connectorItem);
	if (found != m_busGroupForConnector.constEnd())
		return found.value();

	const int groupId = m_busGroupCount++;
	m_busGroupForConnector.insert(connectorItem, groupId);
	ItemBase *item = connectorItem->attachedTo();
	QList<ConnectorItem *> busSiblings;
	if (item != nullptr && item->busConnectorItems(connectorItem, busSiblings))
	{
		Q_FOREACH (ConnectorItem *sibling, busSiblings)
		{
			if (sibling != nullptr && !m_busGroupForConnector.contains(sibling))
				m_busGroupForConnector.insert(sibling, groupId);
		}
	}
	return groupId;
}

const QList<QPair<ConnectorItem *, ConnectorItem *> > &BreadboardAutorouter::normalBreadboardWireEnds() const
{
	if (m_wireEndsCacheValid)
		return m_normalBreadboardWireEnds;

	m_normalBreadboardWireEnds.clear();
	Q_FOREACH (QGraphicsItem *graphicsItem, m_sketchWidget->scene()->items())
	{
		auto *wire = dynamic_cast<Wire *>(graphicsItem);
		if (wire == nullptr || wire->getRatsnest() || !wire->getNormal())
			continue;
		if (wire->viewID() != ViewLayer::BreadboardView)
			continue;

		ConnectorItem *from = routingConnectorFor(wire->connector0());
		ConnectorItem *to = routingConnectorFor(wire->connector1());
		if (from == nullptr || to == nullptr)
			continue;
		m_normalBreadboardWireEnds.append(qMakePair(from, to));
	}
	m_wireEndsCacheValid = true;
	return m_normalBreadboardWireEnds;
}

int BreadboardAutorouter::busOwner(int busGroup) const
{
	return m_busOwnerForGroup.value(busGroup, -1);
}

bool BreadboardAutorouter::busAvailableFor(int busGroup, int ownerKey) const
{
	const int owner = busOwner(busGroup);
	return owner == -1 || owner == ownerKey;
}

void BreadboardAutorouter::claimBus(int busGroup, int ownerKey)
{
	if (!m_busOwnerForGroup.contains(busGroup))
		m_busOwnerForGroup.insert(busGroup, ownerKey);
}

int BreadboardAutorouter::makeNoNetOwnerKey()
{
	return m_nextNoNetOwnerKey--;
}

int BreadboardAutorouter::ownerKeyForPin(ConnectorItem *pin) const
{
	// Netted pins share their net's key; a no-net pin gets no shared key
	// here - callers claim with a fresh sentinel so nothing may join it.
	return m_netForConnector.value(pin, INT_MIN);
}

void BreadboardAutorouter::seedBusOwnership()
{
	m_busOwnerForGroup.clear();
	m_nextNoNetOwnerKey = -2;
	m_netForConnector.clear();
	for (int netIndex = 0; netIndex < m_allPartConnectorItems.count(); netIndex++)
	{
		QList<ConnectorItem *> *net = m_allPartConnectorItems.at(netIndex);
		if (net == nullptr)
			continue;
		Q_FOREACH (ConnectorItem *connectorItem, *net)
		{
			if (connectorItem == nullptr)
				continue;
			m_netForConnector.insert(connectorItem, netIndex);
			// Only a real male PART pin actually plugged into a hole claims a
			// bus at seed time. Female connectors are breadboard holes/sockets
			// (they are net members but occupy nothing themselves), and
			// connectedBreadboardHoleFor returns a female pin as itself - which
			// would wrongly claim every hosting bus before placement even runs.
			if (connectorItem->connectorType() == Connector::Female)
				continue;
			if (connectorItem->attachedToItemType() == ModelPart::Wire)
				continue;
			ConnectorItem *hole = connectedBreadboardHoleFor(connectorItem);
			if (hole == nullptr || hole->connectorType() != Connector::Female)
				continue;
			const int busGroup = busGroupFor(hole);
			const int owner = busOwner(busGroup);
			if (owner == -1)
				claimBus(busGroup, netIndex);
			else if (owner != netIndex)
				logAutoroute(QString("bus ownership seed conflict (pre-existing): bus=%1 owner=net%2 also touched by net%3 pin=%4")
								 .arg(busGroup)
								 .arg(owner)
								 .arg(netIndex)
								 .arg(connectorSummary(connectorItem)));
		}
	}

	// Pins with no net already sitting in holes (pre-placed parts) claim
	// their buses exclusively.
	Q_FOREACH (QGraphicsItem *graphicsItem, m_sketchWidget->scene()->items())
	{
		auto *connectorItem = dynamic_cast<ConnectorItem *>(graphicsItem);
		if (connectorItem == nullptr || connectorItem->attachedTo() == nullptr)
			continue;
		if (connectorItem->attachedTo()->getRatsnest() || !connectorItem->attachedTo()->isEverVisible())
			continue;
		if (connectorItem->connectorType() == Connector::Female)
			continue;
		if (connectorItem->attachedToItemType() == ModelPart::Wire)
			continue;
		if (m_netForConnector.contains(connectorItem))
			continue;
		ConnectorItem *hole = connectedBreadboardHoleFor(connectorItem);
		if (hole == nullptr)
			continue;
		const int busGroup = busGroupFor(hole);
		if (busOwner(busGroup) == -1)
			claimBus(busGroup, makeNoNetOwnerKey());
	}
	logAutoroute(QString("bus ownership seeded: ownedBuses=%1 nettedPins=%2").arg(m_busOwnerForGroup.count()).arg(m_netForConnector.count()));
}

bool BreadboardAutorouter::verifySchematicConformance(QStringList &violations, bool recordBaseline)
{
	// Independent short detector, breadboard-view only. Union bus groups
	// that are joined by real breadboard wires, then assert no resulting
	// component carries pins from two different owners (schematic nets, or a
	// no-net pin such as an unused DIP output). Deliberately does NOT walk
	// cross-layer, so it can never mistake the schematic netlist itself for
	// a short. Pre-existing owner contacts are exempt.

	// Owner key per part pin: its schematic net index, or a unique negative
	// id for a no-net pin (each no-net pin is its own singleton owner - it
	// must never share a component with any other owner). Only real MALE
	// part pins count: m_netForConnector also holds female breadboard holes
	// (net members that occupy nothing), which would produce phantom shorts.
	QHash<ConnectorItem *, int> ownerForPin;
	for (auto it = m_netForConnector.constBegin(); it != m_netForConnector.constEnd(); ++it)
	{
		ConnectorItem *pin = it.key();
		if (pin == nullptr || pin->connectorType() == Connector::Female)
			continue;
		if (pin->attachedToItemType() == ModelPart::Wire)
			continue;
		ownerForPin.insert(pin, it.value());
	}
	int nextNoNetId = -2;
	Q_FOREACH (QGraphicsItem *graphicsItem, m_sketchWidget->scene()->items())
	{
		auto *pin = dynamic_cast<ConnectorItem *>(graphicsItem);
		if (pin == nullptr || pin->attachedTo() == nullptr)
			continue;
		if (pin->attachedTo()->getRatsnest() || !pin->attachedTo()->isEverVisible())
			continue;
		if (pin->connectorType() == Connector::Female || pin->attachedToItemType() == ModelPart::Wire)
			continue;
		if (ownerForPin.contains(pin))
			continue;
		if (connectedBreadboardHoleFor(pin) != nullptr)
			ownerForPin.insert(pin, nextNoNetId--);
	}

	// Union-find over bus groups.
	QHash<int, int> parent;
	std::function<int(int)> findRoot = [&](int value) {
		int root = value;
		while (parent.value(root, root) != root) root = parent.value(root, root);
		while (parent.value(value, value) != value) {
			const int next = parent.value(value, value);
			parent[value] = root;
			value = next;
		}
		return root;
	};
	auto unite = [&](int first, int second) {
		const int firstRoot = findRoot(first);
		const int secondRoot = findRoot(second);
		if (firstRoot != secondRoot) parent[firstRoot] = secondRoot;
	};

	// Join buses connected by breadboard wires. Component bodies are NOT
	// wires, so intended part-to-part netlist connections are not unioned -
	// only breadboard copper is.
	using WireEnds = QPair<ConnectorItem *, ConnectorItem *>;
	Q_FOREACH (const WireEnds &ends, normalBreadboardWireEnds())
	{
		ConnectorItem *fromHole = connectedBreadboardHoleFor(ends.first);
		ConnectorItem *toHole = connectedBreadboardHoleFor(ends.second);
		if (fromHole == nullptr || toHole == nullptr)
			continue;
		unite(busGroupFor(fromHole), busGroupFor(toHole));
	}

	// Collect the distinct owners on each component.
	QHash<int, QList<QPair<int, ConnectorItem *> > > ownersByComponent;
	for (auto it = ownerForPin.constBegin(); it != ownerForPin.constEnd(); ++it)
	{
		ConnectorItem *hole = connectedBreadboardHoleFor(it.key());
		if (hole == nullptr)
			continue;
		ownersByComponent[findRoot(busGroupFor(hole))].append(qMakePair(it.value(), it.key()));
	}

	for (auto it = ownersByComponent.constBegin(); it != ownersByComponent.constEnd(); ++it)
	{
		const QList<QPair<int, ConnectorItem *> > &pins = it.value();
		for (int a = 0; a < pins.count(); a++)
		{
			for (int b = a + 1; b < pins.count(); b++)
			{
				if (pins.at(a).first == pins.at(b).first)
					continue;
				const QPair<int, int> contact(qMin(pins.at(a).first, pins.at(b).first),
											  qMax(pins.at(a).first, pins.at(b).first));
				if (recordBaseline)
				{
					m_preExistingNetContacts.insert(contact);
					continue;
				}
				if (m_preExistingNetContacts.contains(contact))
					continue;
				violations.append(QObject::tr("%1 and %2 are joined by breadboard wiring but belong to different schematic nets")
									  .arg(connectorSummary(pins.at(a).second))
									  .arg(connectorSummary(pins.at(b).second)));
			}
		}
	}
	return violations.isEmpty();
}

void BreadboardAutorouter::invalidateRoutingCaches()
{
	m_wireEndsCacheValid = false;
	m_normalBreadboardWireEnds.clear();
	m_busGroupForConnector.clear();
	m_busGroupCount = 0;
}

QString BreadboardAutorouter::connectorSummary(ConnectorItem *connectorItem) const
{
	if (connectorItem == nullptr)
		return QString("<null connector>");

	QPointF p = connectorItem->sceneAdjustedTerminalPoint(nullptr);
	return QString("%1:%2 type=%3 bus=%4 at=(%5,%6) conns=%7")
		.arg(connectorItem->attachedToTitle())
		.arg(connectorItem->connectorSharedID())
		.arg(connectorItem->connectorType())
		.arg(connectorItem->busID())
		.arg(p.x())
		.arg(p.y())
		.arg(connectorItem->connectionsCount());
}

QString BreadboardAutorouter::itemSummary(ItemBase *itemBase) const
{
	if (itemBase == nullptr)
		return QString("<null item>");

	return QString("%1 id=%2 module=%3")
		.arg(itemBase->title())
		.arg(itemBase->id())
		.arg(itemBase->moduleID());
}

void BreadboardAutorouter::loadTuning()
{
	QSettings settings;
	m_maxLegLength = settings.value("breadboardAutorouter/leadStretchLimit", 120.0).toDouble();
	m_leadLengthWeight = settings.value("breadboardAutorouter/leadLengthWeight", 1.0).toDouble();
	m_jumperPenalty = settings.value("breadboardAutorouter/jumperPenalty", 100000.0).toDouble();
	m_leadAngleWeight = settings.value("breadboardAutorouter/leadAngleWeight", 4.0).toDouble();
	m_foldbackWeight = settings.value("breadboardAutorouter/foldbackWeight", 6.0).toDouble();
}

QString BreadboardAutorouter::logFilePath() const
{
	QString dir = QStandardPaths::writableLocation(QStandardPaths::TempLocation);
	if (dir.isEmpty())
		dir = QDir::tempPath();
	return QDir(dir).filePath("fritzing-breadboard-autorouter.log");
}

void BreadboardAutorouter::logAutoroute(const QString &message) const
{
	m_logBuffer.append(QDateTime::currentDateTime().toString(Qt::ISODateWithMs) + " " + message);
	// Cap memory without losing the tail on a crash mid-phase.
	if (m_logBuffer.count() >= 512)
		flushAutorouteLog();
}

void BreadboardAutorouter::flushAutorouteLog() const
{
	if (m_logBuffer.isEmpty())
		return;

	QFile file(logFilePath());
	if (!file.open(QIODevice::WriteOnly | QIODevice::Append | QIODevice::Text))
		return;

	QTextStream stream(&file);
	Q_FOREACH (const QString &line, m_logBuffer)
		stream << line << '\n';
	m_logBuffer.clear();
}

ConnectorItem *BreadboardAutorouter::connectedPartConnector(ConnectorItem *wireConnector) const
{
	if (wireConnector == nullptr)
		return nullptr;

	Q_FOREACH (ConnectorItem *connectorItem, wireConnector->connectedToItems())
	{
		if (connectorItem == nullptr)
			continue;
		ItemBase *itemBase = connectorItem->attachedTo();
		if (itemBase == nullptr)
			continue;
		if (!itemBase->isEverVisible())
			continue;
		if (itemBase->getRatsnest())
			continue;
		if (connectorItem->attachedToItemType() == ModelPart::Wire)
			continue;

		return connectorItem;
	}

	return nullptr;
}

ConnectorItem *BreadboardAutorouter::connectedBreadboardHoleFor(ConnectorItem *partConnector) const
{
	if (partConnector == nullptr)
		return nullptr;
	if (partConnector->connectorType() == Connector::Female)
		return isBreadboardHoleConnector(partConnector) ? partConnector : nullptr;

	Q_FOREACH (ConnectorItem *connectorItem, partConnector->connectedToItems())
	{
		if (connectorItem == nullptr)
			continue;
		ItemBase *itemBase = connectorItem->attachedTo();
		if (itemBase == nullptr)
			continue;
		if (!itemBase->isEverVisible())
			continue;
		if (itemBase->getRatsnest())
			continue;
		if (connectorItem->attachedToItemType() == ModelPart::Wire)
			continue;
		if (isBreadboardHoleConnector(connectorItem))
			return connectorItem;
	}

	return nullptr;
}

ConnectorItem *BreadboardAutorouter::breadboardHoleFor(ConnectorItem *partConnector) const
{
	if (partConnector == nullptr)
		return nullptr;
	if (partConnector->connectorType() == Connector::Female)
		return isBreadboardHoleConnector(partConnector) ? partConnector : nullptr;

	Q_FOREACH (ConnectorItem *connectorItem, partConnector->connectedToItems())
	{
		if (connectorItem == nullptr)
			continue;
		ItemBase *itemBase = connectorItem->attachedTo();
		if (itemBase == nullptr)
			continue;
		if (!itemBase->isEverVisible())
			continue;
		if (itemBase->getRatsnest())
			continue;
		if (connectorItem->attachedToItemType() == ModelPart::Wire)
			continue;
		if (!isBreadboardHoleConnector(connectorItem))
			continue;

		if (connectorItem->connectionsCount() == 0)
			return connectorItem;

		ConnectorItem *freeHole = nearestFreeBusHole(connectorItem);
		if (freeHole != nullptr)
			return freeHole;
	}

	return nullptr;
}

ConnectorItem *BreadboardAutorouter::nearestFreeBusHole(ConnectorItem *breadboardHole) const
{
	if (breadboardHole == nullptr)
		return nullptr;

	ItemBase *breadboard = breadboardHole->attachedTo();
	if (breadboard == nullptr)
		return nullptr;

	QList<ConnectorItem *> busHoles;
	if (!breadboard->busConnectorItems(breadboardHole, busHoles))
		return nullptr;

	ConnectorItem *nearest = nullptr;
	double nearestDistance = 0;
	QPointF from = breadboardHole->sceneAdjustedTerminalPoint(nullptr);

	Q_FOREACH (ConnectorItem *candidate, busHoles)
	{
		if (candidate == nullptr)
			continue;
		if (candidate == breadboardHole)
			continue;
		if (candidate->connectorType() != Connector::Female)
			continue;
		if (candidate->connectionsCount() != 0)
			continue;
		if (!candidate->attachedTo()->isEverVisible())
			continue;

		QPointF to = candidate->sceneAdjustedTerminalPoint(nullptr);
		double distance = QLineF(from, to).length();
		if (nearest == nullptr || distance < nearestDistance)
		{
			nearest = candidate;
			nearestDistance = distance;
		}
	}

	return nearest;
}

ConnectorItem *BreadboardAutorouter::routingConnectorFor(ConnectorItem *wireConnector) const
{
	ConnectorItem *partConnector = connectedPartConnector(wireConnector);
	ConnectorItem *breadboardHole = breadboardHoleFor(partConnector);
	return breadboardHole == nullptr ? partConnector : breadboardHole;
}

QList<QList<ConnectorItem *>> BreadboardAutorouter::collectRoutableSubnets(QList<ConnectorItem *> *net) const
{
	QList<QList<ConnectorItem *>> subnets;
	if (net == nullptr)
		return subnets;

	QList<ConnectorItem *> todo = *net;
	while (!todo.isEmpty())
	{
		ConnectorItem *first = todo.takeFirst();
		QList<ConnectorItem *> subnet;
		subnet.append(first);

		ConnectorItem::collectEqualPotential(subnet, false, ViewGeometry::RatsnestFlag);
		Q_FOREACH (ConnectorItem *connectorItem, subnet)
		{
			todo.removeOne(connectorItem);
		}

		ConnectorItem *representative = chooseRepresentative(subnet);
		if (representative != nullptr)
		{
			subnets.append(subnet);
		}
	}

	return subnets;
}

QList<ConnectorItem *> BreadboardAutorouter::routingCandidatesForSubnet(const QList<ConnectorItem *> &subnet) const
{
	QList<ConnectorItem *> candidates;

	Q_FOREACH (ConnectorItem *connectorItem, subnet)
	{
		if (connectorItem == nullptr)
			continue;
		ItemBase *itemBase = connectorItem->attachedTo();
		if (itemBase == nullptr)
			continue;
		if (!itemBase->isEverVisible())
			continue;
		if (itemBase->getRatsnest())
			continue;
		if (connectorItem->attachedToItemType() == ModelPart::Wire)
			continue;

		ConnectorItem *breadboardHole = breadboardHoleFor(connectorItem);
		if (breadboardHole == nullptr)
		{
			logAutoroute(QString("route candidate skipped off-board terminal: %1").arg(connectorSummary(connectorItem)));
			continue;
		}
		if (!candidates.contains(breadboardHole))
			candidates.append(breadboardHole);
	}

	return candidates;
}

ConnectorItem *BreadboardAutorouter::chooseRepresentative(const QList<ConnectorItem *> &subnet) const
{
	QList<ConnectorItem *> candidates = routingCandidatesForSubnet(subnet);
	return candidates.isEmpty() ? nullptr : candidates.first();
}

double BreadboardAutorouter::partConnectivityScore(ItemBase *part, const QHash<ConnectorItem *, int> &netForConnector, const QHash<int, QList<ConnectorItem *>> &connectorsForNet) const
{
	if (part == nullptr)
		return 0;

	QSet<int> seenNets;
	double score = 0;
	Q_FOREACH (ConnectorItem *connectorItem, part->cachedConnectorItems())
	{
		if (connectorItem == nullptr)
			continue;
		if (!isPlaceablePin(connectorItem))
			continue;

		int netIndex = netForConnector.value(connectorItem, -1);
		if (netIndex < 0 || seenNets.contains(netIndex))
			continue;
		seenNets.insert(netIndex);

		int visiblePinsInNet = 0;
		Q_FOREACH (ConnectorItem *netConnector, connectorsForNet.value(netIndex))
		{
			if (netConnector == nullptr)
				continue;
			ItemBase *itemBase = netConnector->attachedTo();
			if (itemBase == nullptr)
				continue;
			if (!itemBase->isEverVisible())
				continue;
			if (itemBase->getRatsnest())
				continue;
			if (netConnector->attachedToItemType() == ModelPart::Wire)
				continue;
			visiblePinsInNet++;
		}

		score += qMax(1, visiblePinsInNet);
	}

	return score;
}

double BreadboardAutorouter::routeScore(ConnectorItem *from, ConnectorItem *to) const
{
	if (from == nullptr || to == nullptr)
		return std::numeric_limits<double>::max();

	QPointF fromPos = from->sceneAdjustedTerminalPoint(nullptr);
	QPointF toPos = to->sceneAdjustedTerminalPoint(nullptr);
	double score = qAbs(fromPos.x() - toPos.x()) + qAbs(fromPos.y() - toPos.y());

	bool fromBreadboard = from->connectorType() == Connector::Female;
	bool toBreadboard = to->connectorType() == Connector::Female;
	if (fromBreadboard && toBreadboard)
		score *= 0.5;
	else if (!fromBreadboard && !toBreadboard)
		score *= 4.0;

	return score;
}

void BreadboardAutorouter::clearCollectedNets()
{
	qDeleteAll(m_allPartConnectorItems);
	m_allPartConnectorItems.clear();
}
