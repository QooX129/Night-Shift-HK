import json
from pathlib import Path
import unittest

from fastapi.testclient import TestClient

from app import app
from tools.prepare_transport import extract


ROOT = Path(__file__).resolve().parents[1]


class TransportTests(unittest.TestCase):
    def test_extracts_public_transport_nodes_and_ways(self):
        source = b"""<osm>
          <node id="1" lat="22.314" lon="114.1695"><tag k="amenity" v="taxi"/></node>
          <node id="2" lat="22.314" lon="114.1696"><tag k="highway" v="bus_stop"/></node>
          <node id="3" lat="22.314" lon="114.1697"><tag k="railway" v="subway_entrance"/><tag k="ref" v="A"/></node>
          <node id="4" lat="22.314" lon="114.1698"/>
          <node id="5" lat="22.314" lon="114.1699"><tag k="amenity" v="taxi"/><tag k="access" v="private"/></node>
          <node id="6" lat="22.314" lon="114.1699"><tag k="railway" v="subway_entrance"/><tag k="subway" v="no"/></node>
          <node id="7" lat="23" lon="114"><tag k="highway" v="bus_stop"/></node>
          <node id="9" lat="22.314" lon="114.1697"><tag k="railway" v="subway_entrance"/><tag k="level" v="1"/></node>
          <node id="10" lat="22.314" lon="114.1697"><tag k="railway" v="subway_entrance"/><tag k="level" v="-1"/></node>
          <node id="11" lat="22.314" lon="114.1697"><tag k="railway" v="subway_entrance"/><tag k="indoor" v="yes"/></node>
          <node id="12" lat="22.314" lon="114.1697"><tag k="railway" v="subway_entrance"/><tag k="location" v="podium"/></node>
          <node id="13" lat="22.314" lon="114.1697"><tag k="railway" v="subway_entrance"/><tag k="location" v="underground"/></node>
          <node id="14" lat="22.314" lon="114.1697"><tag k="railway" v="subway_entrance"/><tag k="level" v="0"/></node>
          <way id="8"><nd ref="2"/><nd ref="4"/><tag k="amenity" v="bus_station"/></way>
          <relation id="15">
            <tag k="public_transport" v="stop_area"/><tag k="subway" v="yes"/>
            <tag k="name:en" v="Mong Kok"/><tag k="name:zh" v="Mong Kok Chinese"/>
            <member type="node" ref="3" role="entrance"/>
          </relation>
          <relation id="16">
            <tag k="public_transport" v="stop_area"/><tag k="name" v="Nearby bus stop"/>
            <member type="node" ref="3" role="platform"/>
          </relation>
        </osm>"""
        result = extract(source)
        self.assertEqual([(item["id"], item["kind"]) for item in result], [
            ("osm-node-1", "taxi"), ("osm-node-2", "bus"),
            ("osm-node-3", "mtr"), ("osm-node-14", "mtr"), ("osm-way-8", "bus"),
        ])
        self.assertEqual(result[2]["ref"], "A")
        self.assertEqual(result[2]["station"], {
            "id": "osm-relation-15", "name": "Mong Kok", "zh": "Mong Kok Chinese",
        })
        self.assertNotIn("station", result[3])
        self.assertEqual(result[0]["point"], [0, 0])

    def test_missing_way_geometry_fails(self):
        with self.assertRaises(KeyError):
            extract(b'<osm><way id="1"><nd ref="2"/><tag k="amenity" v="taxi"/></way></osm>')

    def test_station_member_supplies_labels_when_relation_has_no_language_tags(self):
        source = b"""<osm>
          <node id="1" lat="22.314" lon="114.1695"><tag k="railway" v="subway_entrance"/></node>
          <node id="2" lat="22.314" lon="114.1696"/>
          <node id="3" lat="22.314" lon="114.1697"/>
          <way id="4"><nd ref="2"/><nd ref="3"/>
            <tag k="railway" v="station"/><tag k="name:en" v="Olympic"/><tag k="name:zh" v="Olympic Chinese"/>
          </way>
          <relation id="5"><tag k="public_transport" v="stop_area"/><tag k="name" v="Combined label"/>
            <member type="way" ref="4" role=""/><member type="node" ref="1" role=""/>
          </relation>
        </osm>"""
        self.assertEqual(extract(source)[0]["station"], {
            "id": "osm-relation-5", "name": "Olympic", "zh": "Olympic Chinese",
        })

    def test_packaged_locations_are_in_both_map_responses(self):
        package = json.loads((ROOT / "data" / "transport.json").read_text(encoding="utf-8"))
        features = package["features"]
        self.assertEqual({item["kind"] for item in features}, {"taxi", "bus", "mtr"})
        self.assertEqual(len({item["id"] for item in features}), len(features))
        self.assertTrue(all(item.get("station", {}).get("name") for item in features if item["kind"] == "mtr"))
        client = TestClient(app)
        self.assertEqual(client.get("/api/transport").json(), package)
        for url in ("/api/map", "/api/map?stream=true"):
            self.assertEqual(client.get(url).json()["transport"], features)


if __name__ == "__main__":
    unittest.main()
