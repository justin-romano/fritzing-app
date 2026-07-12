#define BOOST_TEST_MODULE Breadboard route graph core tests
#include <boost/test/included/unit_test.hpp>

#include "autoroute/breadboardroutegraphcore.h"

// Fixture: a tiny synthetic board. Three vertical 3-hole "column" buses at
// x = 0, 30, 300 (bus 0, 1, 2), holes 9 apart vertically. Bus 2 is out of
// jumper reach (maxJumperLength = 100) from bus 0 but reachable from bus 1
// only when maxJumperLength allows 270.
struct TinyBoard
{
	QVector<QPointF> positions;
	QVector<int> buses;
	BreadboardRouteGraphCore::Options options;

	TinyBoard()
	{
		const double columnsX[3] = {0.0, 30.0, 300.0};
		for (int bus = 0; bus < 3; bus++)
			for (int row = 0; row < 3; row++)
			{
				positions.append(QPointF(columnsX[bus], row * 9.0));
				buses.append(bus);
			}
		options.maxJumperLength = 100.0;
		options.candidatesPerBusPair = 4;
	}

	int hole(int bus, int row) const { return bus * 3 + row; }
	QVector<bool> noneBlocked() const { return QVector<bool>(positions.count(), false); }
};

BOOST_FIXTURE_TEST_CASE(same_bus_needs_no_jumper, TinyBoard)
{
	BreadboardRouteGraphCore graph(positions, buses, options);
	const auto result = graph.route(hole(0, 0), hole(0, 2), graph.prepareQuery(noneBlocked(), {}));
	BOOST_REQUIRE(result.found);
	BOOST_CHECK_EQUAL(result.segments.count(), 0);
}

BOOST_FIXTURE_TEST_CASE(adjacent_buses_get_one_shortest_jumper, TinyBoard)
{
	BreadboardRouteGraphCore graph(positions, buses, options);
	const auto result = graph.route(hole(0, 0), hole(1, 2), graph.prepareQuery(noneBlocked(), {}));
	BOOST_REQUIRE(result.found);
	BOOST_REQUIRE_EQUAL(result.segments.count(), 1);
	// Shortest hole pair between the buses is any same-row pair (length 30).
	BOOST_CHECK_CLOSE(result.score.jumperLength, 30.0, 1e-6);
	BOOST_CHECK_EQUAL(result.score.jumperCount, 1);
}

BOOST_FIXTURE_TEST_CASE(unreachable_bus_reports_no_route, TinyBoard)
{
	BreadboardRouteGraphCore graph(positions, buses, options);
	const auto result = graph.route(hole(0, 0), hole(2, 0), graph.prepareQuery(noneBlocked(), {}));
	BOOST_CHECK(!result.found);
	BOOST_CHECK(!result.reason.isEmpty());
}

BOOST_FIXTURE_TEST_CASE(longer_reach_routes_multi_hop, TinyBoard)
{
	options.maxJumperLength = 280.0;
	BreadboardRouteGraphCore graph(positions, buses, options);
	const auto result = graph.route(hole(0, 0), hole(2, 0), graph.prepareQuery(noneBlocked(), {}));
	BOOST_REQUIRE(result.found);
	// 0 -> 2 directly is 300 (too long); 0 -> 1 -> 2 is 30 + 270.
	BOOST_CHECK_EQUAL(result.score.jumperCount, 2);
	BOOST_CHECK_CLOSE(result.score.jumperLength, 300.0, 1e-6);
}

BOOST_FIXTURE_TEST_CASE(blocked_holes_are_avoided, TinyBoard)
{
	BreadboardRouteGraphCore graph(positions, buses, options);
	QVector<bool> blocked = noneBlocked();
	// Block every bus-1 hole except row 2: the jumper must land there.
	blocked[hole(1, 0)] = true;
	blocked[hole(1, 1)] = true;
	const auto result = graph.route(hole(0, 0), hole(1, 2), graph.prepareQuery(noneBlocked(), {}));
	BOOST_REQUIRE(result.found);

	const auto constrained = graph.route(hole(0, 0), hole(1, 2), graph.prepareQuery(blocked, {}));
	BOOST_REQUIRE(constrained.found);
	Q_FOREACH (const auto & segment, constrained.segments)
	{
		BOOST_CHECK(segment.fromHole != hole(1, 0) && segment.toHole != hole(1, 0));
		BOOST_CHECK(segment.fromHole != hole(1, 1) && segment.toHole != hole(1, 1));
	}
}

BOOST_FIXTURE_TEST_CASE(fully_blocked_bus_is_unroutable, TinyBoard)
{
	BreadboardRouteGraphCore graph(positions, buses, options);
	QVector<bool> blocked = noneBlocked();
	for (int row = 0; row < 3; row++)
		blocked[hole(1, row)] = true;
	// Target holes stay usable even when flagged, so aim at bus 1 row 0 but
	// block the whole bus: routing TO it still works (endpoint exemption)...
	const auto toBlocked = graph.route(hole(0, 0), hole(1, 0), graph.prepareQuery(blocked, {}));
	BOOST_CHECK(toBlocked.found);
	// ...but THROUGH it (0 -> 2 multi-hop with reach 280) must fail.
	options.maxJumperLength = 280.0;
	BreadboardRouteGraphCore farGraph(positions, buses, options);
	QVector<bool> blockedFar = blocked;
	const auto throughBlocked = farGraph.route(hole(0, 0), hole(2, 0), farGraph.prepareQuery(blockedFar, {}));
	// Direct 0->2 is 300 > 280 and the only intermediate bus is blocked.
	BOOST_CHECK(!throughBlocked.found);
}

BOOST_FIXTURE_TEST_CASE(congestion_diverts_to_uncrossed_candidate, TinyBoard)
{
	BreadboardRouteGraphCore graph(positions, buses, options);
	// A planned segment lies across the row-0 corridor between bus 0 and 1.
	QList<QLineF> planned;
	planned.append(QLineF(QPointF(15.0, -9.0), QPointF(15.0, 4.5)));
	const auto result = graph.route(hole(0, 0), hole(1, 0), graph.prepareQuery(noneBlocked(), planned));
	BOOST_REQUIRE(result.found);
	// The crossing-free row exists, so no congestion should be paid.
	BOOST_CHECK_SMALL(result.score.congestion, 1e-9);
}

BOOST_FIXTURE_TEST_CASE(results_are_deterministic, TinyBoard)
{
	options.maxJumperLength = 280.0;
	BreadboardRouteGraphCore graph(positions, buses, options);
	const auto first = graph.route(hole(0, 0), hole(2, 2), graph.prepareQuery(noneBlocked(), {}));
	for (int i = 0; i < 5; i++)
	{
		const auto again = graph.route(hole(0, 0), hole(2, 2), graph.prepareQuery(noneBlocked(), {}));
		BOOST_REQUIRE_EQUAL(again.found, first.found);
		BOOST_REQUIRE_EQUAL(again.segments.count(), first.segments.count());
		for (int s = 0; s < again.segments.count(); s++)
		{
			BOOST_CHECK_EQUAL(again.segments.at(s).fromHole, first.segments.at(s).fromHole);
			BOOST_CHECK_EQUAL(again.segments.at(s).toHole, first.segments.at(s).toHole);
		}
	}
}

BOOST_AUTO_TEST_CASE(congestion_penalty_cases)
{
	const double crossing = 700.0;
	const double overlap = 1200.0;
	const QLineF candidate(QPointF(0, 0), QPointF(100, 0));

	// Bounded crossing pays the crossing penalty.
	BOOST_CHECK_CLOSE(BreadboardRouteGraphCore::congestionPenalty(
						  candidate, {QLineF(QPointF(50, -10), QPointF(50, 10))}, crossing, overlap),
					  crossing, 1e-9);
	// Collinear overlap pays the overlap penalty.
	BOOST_CHECK_CLOSE(BreadboardRouteGraphCore::congestionPenalty(
						  candidate, {QLineF(QPointF(40, 0), QPointF(140, 0))}, crossing, overlap),
					  overlap, 1e-9);
	// Sharing an endpoint is free (wires meeting at a hole).
	BOOST_CHECK_SMALL(BreadboardRouteGraphCore::congestionPenalty(
						  candidate, {QLineF(QPointF(100, 0), QPointF(100, 50))}, crossing, overlap),
					  1e-9);
	// Disjoint segments are free.
	BOOST_CHECK_SMALL(BreadboardRouteGraphCore::congestionPenalty(
						  candidate, {QLineF(QPointF(0, 20), QPointF(100, 20))}, crossing, overlap),
					  1e-9);
}

