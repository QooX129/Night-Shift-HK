import { Map3DView } from "./map3d.mjs?v=orders-terrain-merge-1";
import { MapView } from "./map.mjs?v=orders-terrain-merge-1";

let view;
self.onmessage = ({ data }) => {
  if (data.type === "init") {
    view = Object.create(Map3DView.prototype);
    view.data = data.map;
    view.groundMap = Object.create(MapView.prototype);
    view.groundMap.data = data.map;
    view.groundMap.unique = data.edges;
    view.groundMap.drawCollisionLines = () => {};
    view.detailSize = data.size;
    view.detailScale = data.scale;
    const canvas = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1);
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (context) {
      view.detailMap = Object.create(view.groundMap);
      view.detailMap.backdrop = canvas;
      view.detailMap.drawRoadDirections = () => {};
      context.fillText = () => {};
      context.strokeText = () => {};
    } else {
      console.warn("OffscreenCanvas 2D unavailable; 3D road textures will refresh on the main thread.");
    }
    view.directionLines = { geometry: { dispose() {} } };
    return;
  }
  view.updateDirections(data.x, data.y);
  let image = null;
  if (view.detailMap) {
    const half = view.detailSize / 2;
    view.detailMap.buildBackdrop([data.x - half, data.y - half, data.x + half, data.y + half], view.detailScale);
    const canvas = view.detailMap.backdrop;
    image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  }
  const geometries = [view.directionLines.geometry];
  const buffers = geometries.map(geometry => ({
    position: geometry.getAttribute("position").array,
    boundaryCoord: geometry.getAttribute("boundaryCoord").array,
  }));
  self.postMessage({ x: data.x, y: data.y, buffers, image },
    [...(image ? [image.data.buffer] : []), ...buffers.flatMap(attributes => Object.values(attributes).map(array => array.buffer))]);
};
