import json
import math
import shutil
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from game import Game, RuleError, Session
from roads import RoadMap


ROOT = Path(__file__).resolve().parents[1]


class ForcedJunctionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        edges = [
            dict(id=key, a=a, b=b, way=way, length=60, name=key, zh=key,
                 kind="residential", oneway=False, layer="1" if key == "bd" else "0",
                 bridge="no", tunnel="no")
            for key, a, b, way in [("ab", "a", "b", 1), ("bc", "b", "c", 2), ("bd", "b", "d", 3)]
        ]
        path = Path(directory.name) / "map.json"
        path.write_text(json.dumps(dict(
            version="test", nodes={"a": [0, 0], "b": [60, 0], "c": [120, 0], "d": [60, 60]},
            edges=edges, bounds=[-100, -100, 200, 200], restrictions=[],
        )))
        self.roads = RoadMap(path)
        self.game = Game.__new__(Game)
        self.game.roads = self.roads
        self.game.incident_ways = []

    def session(self, point=(59, 0)):
        return Session("test", point, 0, "ab", (1,), speed=10, paused=False,
                       selected_exit="bd", selected_junction="b")

    def test_selection_queues_turn_without_moving_the_taxi(self):
        for angle in [0, math.pi / 2, -math.pi / 2, math.pi - 0.1, -math.pi + 0.1]:
            for length in [1, 60]:
                with self.subTest(angle=angle, length=length):
                    self.roads.nodes["d"] = (60 + math.cos(angle) * length, math.sin(angle) * length)
                    self.roads.edges["bd"] = replace(self.roads.edges["bd"], length=length)
                    self.roads.outgoing["b"] = [
                        self.roads.edges[edge.id] for edge in self.roads.outgoing["b"]
                    ]
                    session = self.session((15, 0))
                    session.paused = True
                    old = (session.point, session.heading, session.edge, session.history,
                           session.speed, session.elapsed, session.fuel)
                    self.game.select_road(session, "ab", "bd")
                    self.assertEqual((session.point, session.heading, session.edge, session.history,
                                      session.speed, session.elapsed, session.fuel), old)
                    self.assertEqual(session.selected_exit, "bd")
                    self.assertFalse(session.paused)
                    self.game.update_position(session, dict(
                        x=16, y=0, heading=session.heading, speed=10, dt=1 / 6,
                    ))
                    self.assertEqual(session.edge, "ab")
                    self.assertEqual(session.selected_exit, "bd")

    def test_selection_keeps_restriction_warning_and_turn_history(self):
        self.roads.node_rules["b"] = [{
            "from": 1, "to": 3, "rule": "no_right_turn", "via_ways": [], "via": "b",
        }]
        session = self.session()
        session.paused = True
        self.game.select_road(session, "ab", "bd")
        self.assertEqual(session.warning, "")
        self.assertEqual(session.history, (1,))
        self.game.update_position(session, dict(
            x=60, y=1, heading=math.pi / 2, speed=10, dt=0.2,
            trail=[dict(x=60, y=0, heading=0)],
        ))
        self.assertEqual(session.warning, "restricted")
        self.assertEqual(session.history, self.roads.history((1,), 3))

    def test_invalid_selection_does_not_move_the_taxi(self):
        for exit_id, closed in [("missing", set()), ("bd", {3})]:
            with self.subTest(exit=exit_id):
                session = self.session()
                session.paused = True
                session.closed = closed
                old = session.point, session.heading, session.edge, session.history
                with self.assertRaises(RuleError):
                    self.game.select_road(session, "ab", exit_id)
                self.assertEqual((session.point, session.heading, session.edge, session.history), old)
                self.assertTrue(session.paused)

    def test_selected_matching_excludes_wrong_exit_without_relaxing_boundaries(self):
        self.assertIsNone(self.roads.corridor_match((68, 0), 0, self.roads.edges["ab"], "bd", "b"))
        match = self.roads.corridor_match((60, 0), 0, self.roads.edges["ab"], "bd", "b")
        self.assertIsNotNone(match)
        session = self.session()
        with self.assertRaises(RuleError):
            self.game.update_position(session, dict(x=68, y=0, heading=0, speed=10, dt=1))
        self.assertEqual(session.point, (59, 0))

    def test_client_wall_contacts_and_aligned_trails_are_accepted(self):
        node = shutil.which("node")
        if not node:
            installed = sorted((Path.home() / ".nvm/versions/node").glob("*/bin/node"))
            node = str(installed[-1]) if installed else None
        if not node:
            self.skipTest("Node.js is required for client/server physics integration")
        script = """
import { RoadNetwork, stepCar } from './web/physics.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const roads = new RoadNetwork(JSON.parse(input));
const cases = [];
for (const start of [[45, 0, 0], [59, 0, 0], [59, 0.9, 1.2], [60, 1, 0.4]]) {
  for (const right of [false, true]) {
    const car = { x: start[0], y: start[1], heading: start[2], speed: 10, edge: 'ab' };
    const batches = [];
    for (let batch = 0; batch < 10; batch++) {
      const trail = [];
      let contacts = 0;
      let snaps = 0;
      for (let frame = 0; frame < 18; frame++) {
        const result = stepCar(car, { gas: true, right }, 1 / 60,
          { roads, selectedExit: 'bd', selectedJunction: 'b' });
        if (result.blocked) contacts++;
        if (result.junctionPoint) { trail.push(result.junctionPoint); snaps++; }
        trail.push({ x: car.x, y: car.y, heading: car.heading });
      }
      batches.push({ x: car.x, y: car.y, heading: car.heading, speed: car.speed,
        dt: 0.3, trail, contacts, snaps });
    }
    cases.push({ start, batches });
  }
}
console.log(JSON.stringify(cases));
"""
        result = subprocess.run(
            [node, "--input-type=module", "-e", script], cwd=ROOT,
            input=json.dumps(self.roads.document), text=True, capture_output=True, check=True,
        )
        contacts = 0
        snaps = 0
        for case in json.loads(result.stdout):
            session = self.session(tuple(case["start"][:2]))
            session.heading = case["start"][2]
            for batch in case["batches"]:
                contacts += batch.pop("contacts")
                snaps += batch.pop("snaps")
                # A client may retain its selection while the previous response is in flight.
                self.game.update_position(session, batch)
                self.assertTrue(math.isfinite(session.heading))
        self.assertGreater(contacts, 0, "the regression must exercise actual wall contact")
        self.assertGreater(snaps, 0, "the regression must submit a junction snap trail")
