import { Map3DView } from "./map3d.mjs?v=local-map-popup-1";
import { MapView } from "./map.mjs?v=taxi-map-icons-1";

let view;
self.onmessage = ({ data }) => {
  if (data.type === "init") {
    view = Object.create(Map3DView.prototype);
    view.data = data.map;
    view.nodes = data.map.nodes;
    view.elevation = data.map.elevation;
    view.edges = new Map(data.map.edges.map(edge => [edge.id, edge]));
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
  if (data.type === "route") {
    const geometry = view.ribbonGeometry(data.ids.map(id => view.edges.get(id)), data.width, data.height);
    const attributes = Object.fromEntries(Object.entries(geometry.attributes).map(([name, attribute]) =>
      [name, { array: attribute.array, itemSize: attribute.itemSize }]));
    geometry.dispose();
    self.postMessage({ type: "route", request: data.request, attributes,
      edgeStarts: geometry.userData.edgeStarts }, Object.values(attributes).map(attribute => attribute.array.buffer));
    return;
  }
  if (!view.data.elevation) view.updateDirections(data.x, data.y);
  let image = null;
  const mipmaps = [];
  if (view.detailMap) {
    const half = view.detailSize / 2;
    view.detailMap.buildBackdrop([data.x - half, data.y - half, data.x + half, data.y + half], view.detailScale);
    const canvas = view.detailMap.backdrop;
    image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    if (view.data.elevation) {
      let previous = canvas;
      while (previous.width > 1 || previous.height > 1) {
        const next = new OffscreenCanvas(Math.max(1, previous.width >> 1), Math.max(1, previous.height >> 1));
        const context = next.getContext("2d", { willReadFrequently: true });
        context.drawImage(previous, 0, 0, next.width, next.height);
        mipmaps.push(context.getImageData(0, 0, next.width, next.height));
        previous = next;
      }
    }
  }
  const geometries = view.data.elevation ? [] : [view.directionLines.geometry];
  const buffers = geometries.map(geometry => ({
    position: geometry.getAttribute("position").array,
    boundaryCoord: geometry.getAttribute("boundaryCoord").array,
  }));
  self.postMessage({ x: data.x, y: data.y, buffers, image, mipmaps },
    [...(image ? [image.data.buffer] : []), ...mipmaps.map(image => image.data.buffer),
      ...buffers.flatMap(attributes => Object.values(attributes).map(array => array.buffer))]);
};
