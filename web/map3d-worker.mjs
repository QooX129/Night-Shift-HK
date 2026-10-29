import { Map3DView } from "./map3d.mjs?v=minimap-1";
import { MapView } from "./map.mjs?v=minimap-1";

let view;
self.onmessage = ({ data }) => {
  if (data.type === "init") {
    view = Object.create(Map3DView.prototype);
    view.data = data.map;
    view.groundMap = Object.create(MapView.prototype);
    view.groundMap.data = data.map;
    view.groundMap.unique = data.edges;
    view.detailSize = data.size;
    view.boundaryOutline = { geometry: { dispose() {} } };
    view.directionLines = { geometry: { dispose() {} } };
    return;
  }
  view.updateBoundaries(data.x, data.y);
  view.updateDirections(data.x, data.y);
  const geometries = [view.boundaryOutline.geometry, view.directionLines.geometry];
  const buffers = geometries.map(geometry => ({
    position: geometry.getAttribute("position").array,
    boundaryCoord: geometry.getAttribute("boundaryCoord").array,
  }));
  self.postMessage({ x: data.x, y: data.y, buffers },
    buffers.flatMap(attributes => Object.values(attributes).map(array => array.buffer)));
};
