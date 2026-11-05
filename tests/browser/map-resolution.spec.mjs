import { test, expect } from "@playwright/test";

test("elevated terrain uses a sharp scrolling texture for nearby building footprints", async ({ page }) => {
  await page.goto("/");
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const result = await page.evaluate(async () => {
    const { Map3DView } = await import("/map3d.mjs?v=streaming-map-1");
    const THREE = await import("/vendor/three/three.module.min.js");
    const data = {
      bounds: [-300, -300, 300, 300],
      backdrop: [{ kind: "building", points: [[10.37, 10], [20.37, 10], [24.37, 30], [14.37, 30]] }],
      nodes: { a: [-100, -100], b: [100, -100] },
      edges: [{ id: "road", a: "a", b: "b", way: 1, kind: "residential",
        width: 10, length: 200, layer: "0", bridge: "no", tunnel: "no" }],
      driving: { widths: { residential: 10 }, taxi_length: 4.7, taxi_width: 1.7 },
      elevation: { node_heights: { a: 10, b: 10 }, pilot: {}, buildings: [],
        terrain: { origin: [-300, -300], spacing: 600, width: 2, height: 2, values: [10, 10, 10, 10] } },
    };
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const view = new Map3DView(canvas, data, []);
    try {
      const car = { x: 16, y: 16 };
      view.updateGroundDetail(car);
      const texture = view.groundDetail.material.map;
      const initialImage = texture.image;
      const initialBounds = [...view.detailMap.backdropBounds];
      let builds = 0;
      const build = view.detailMap.buildBackdrop;
      view.detailMap.buildBackdrop = function (...args) { builds++; return build.apply(this, args); };
      view.updateGroundDetail(car);
      const reused = texture.image === initialImage && builds === 0;
      for (const object of view.scene.children) object.visible = view.terrainTiles.includes(object);
      view.boundaryScene.visible = false;
      view.lens = new THREE.OrthographicCamera(0, 32, 32, 0, .1, 200);
      view.lens.position.set(0, 100, 32);
      view.lens.up.set(0, 0, -1);
      view.lens.lookAt(0, 10, 32);
      const capture = () => {
        view.drawScene();
        const image = document.createElement("canvas");
        image.width = canvas.width; image.height = canvas.height;
        image.getContext("2d").drawImage(canvas, 0, 0);
        return image;
      };
      const sharp = capture();
      view.terrainDetailEnabled.value = 0;
      const coarse = capture();
      // Use ordinary canvas mapping as an independent reference for the terrain shader.
      build.call(view.detailMap, initialBounds, 8);
      const oldTexture = new THREE.CanvasTexture(view.detailMap.backdrop);
      oldTexture.colorSpace = texture.colorSpace;
      oldTexture.anisotropy = texture.anisotropy;
      oldTexture.repeat.set(600 / view.detailSize, 600 / view.detailSize);
      oldTexture.offset.set((data.bounds[0] - initialBounds[0]) / view.detailSize,
        (initialBounds[3] - data.bounds[3]) / view.detailSize);
      const coarseTexture = view.ground.material.map;
      view.ground.material.map = oldTexture;
      const oldDetail = capture();
      const referenceMap = Object.create(view.detailMap);
      referenceMap.backdrop = document.createElement("canvas");
      const referenceContext = referenceMap.backdrop.getContext("2d");
      referenceContext.fillText = () => {};
      referenceContext.strokeText = () => {};
      build.call(referenceMap, initialBounds, 32);
      const referenceCanvas = referenceMap.backdrop;
      const referenceTexture = new THREE.CanvasTexture(referenceCanvas);
      referenceTexture.colorSpace = texture.colorSpace;
      referenceTexture.anisotropy = texture.anisotropy;
      referenceTexture.repeat.set(600 / view.detailSize, 600 / view.detailSize);
      referenceTexture.offset.set((data.bounds[0] - initialBounds[0]) / view.detailSize,
        (initialBounds[3] - data.bounds[3]) / view.detailSize);
      view.ground.material.map = referenceTexture;
      const reference = capture();
      view.ground.material.map = coarseTexture;
      referenceTexture.dispose();
      oldTexture.dispose();
      const pixels = image => image.getContext("2d").getImageData(0, 0, image.width, image.height).data;
      const expected = pixels(reference), actual = pixels(sharp), old = pixels(coarse), previous = pixels(oldDetail);
      let sharpError = 0, coarseError = 0, oldDetailError = 0;
      for (let y = Math.floor(canvas.height * .35); y < canvas.height * .65; y++) {
        for (let x = Math.floor(canvas.width * .3); x < canvas.width * .85; x++) {
          const index = (y * canvas.width + x) * 4;
          sharpError += Math.abs(actual[index] - expected[index]);
          coarseError += Math.abs(old[index] - expected[index]);
          oldDetailError += Math.abs(previous[index] - expected[index]);
        }
      }
      view.terrainDetailEnabled.value = 1;
      view.detailMap.backdropScale = view.detailScale;
      const response = new Promise(resolve => view.detailWorker.addEventListener("message", resolve, { once: true }));
      const uploads = [];
      const copy = view.renderer.copyTextureToTexture;
      view.renderer.copyTextureToTexture = function (source, ...args) {
        const started = performance.now();
        const result = copy.call(this, source, ...args);
        uploads.push({ bytes: source.image.data.byteLength, ms: performance.now() - started });
        return result;
      };
      view.updateGroundDetail({ x: 80, y: 16 });
      await response;
      view.updateGroundDetail({ x: 80, y: 16 });
      const previousVisible = view.groundDetail.material.map === texture
        && view.terrainDetailBounds.x === initialBounds[0] && Boolean(view.detailUpload);
      let uploadFrames = 1;
      while (view.detailUpload && uploadFrames < 100) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        view.updateGroundDetail({ x: 80, y: 16 });
        uploadFrames++;
      }
      const shifted = view.terrainDetailBounds.x === -64 && view.detailMap.backdropBounds[0] === -64;
      const stable = texture === view.detailSpareTexture && builds === 0;
      const shiftedPixels = pixels(capture());
      let shiftedError = 0;
      for (let i = 0; i < actual.length; i++) shiftedError = Math.max(shiftedError, Math.abs(actual[i] - shiftedPixels[i]));
      const textureCount = view.renderer.info.memory.textures;
      const versions = [texture.version, view.groundDetail.material.map.version];
      const secondResponse = new Promise(resolve => view.detailWorker.addEventListener("message", resolve, { once: true }));
      view.updateGroundDetail({ x: 144, y: 16 });
      await secondResponse;
      do {
        await new Promise(resolve => requestAnimationFrame(resolve));
        view.updateGroundDetail({ x: 144, y: 16 });
      } while (view.detailUpload);
      capture();
      const recycled = view.groundDetail.material.map === texture
        && textureCount === view.renderer.info.memory.textures
        && versions[0] === texture.version && versions[1] === view.detailSpareTexture.version;
      view.overview = true;
      view.updateGroundDetail(car);
      return { sharpError, coarseError, oldDetailError, reused, shifted, stable, previousVisible, recycled,
        uploadFrames, shiftedError, uploadBytes: uploads.map(upload => upload.bytes),
        maxUploadMs: Math.max(...uploads.map(upload => upload.ms)),
        enabledInOverview: view.terrainDetailEnabled.value, flatOverlayVisible: view.groundDetail.visible,
        width: initialImage.width, scale: view.detailScale,
        terrainHeight: view.terrainTiles[0].geometry.getAttribute("position").getY(0) };
    } finally {
      view.dispose();
      view.renderer.forceContextLoss();
      canvas.remove();
    }
  });
  expect(result.scale).toBe(16);
  expect(result.width).toBe(4096);
  expect(result.terrainHeight).toBe(10);
  console.log(`Terrain footprint edge error: ${result.sharpError} detailed / ${result.oldDetailError} previous / ${result.coarseError} district`);
  expect(result.sharpError, JSON.stringify(result)).toBeLessThan(result.coarseError * .5);
  expect(result.sharpError, JSON.stringify(result)).toBeLessThan(result.oldDetailError * .65);
  expect(result.reused && result.shifted && result.stable).toBe(true);
  expect(result.previousVisible).toBe(true);
  expect(result.recycled).toBe(true);
  expect(result.uploadFrames).toBeGreaterThan(1);
  expect(result.uploadFrames).toBeLessThan(100);
  expect(Math.max(...result.uploadBytes)).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.shiftedError).toBeLessThanOrEqual(8);
  expect(result.maxUploadMs).toBeLessThan(30);
  console.log(`Terrain streaming: ${result.uploadFrames} frames, max upload ${result.maxUploadMs} ms`);
  expect(result.enabledInOverview).toBe(0);
  expect(result.flatOverlayVisible).toBe(false);
  expect(errors).toEqual([]);
});

for (const density of [1, 2]) {
  test.describe(`3D building edges at ${density}x pixel density`, () => {
    test.use({ deviceScaleFactor: density });

    test("renders the city at screen resolution with multisampled silhouettes", async ({ page }) => {
      await page.goto("/");
      const result = await page.evaluate(async () => {
        const { Map3DView } = await import("/map3d.mjs?v=streaming-map-1");
        const { DEFAULT_SETTINGS } = await import("/settings.mjs");
        const THREE = await import("/vendor/three/three.module.min.js");
        const data = {
          bounds: [-10, -10, 110, 10], backdrop: [],
          nodes: { a: [0, 0], b: [100, 0] },
          edges: [{ id: "road", a: "a", b: "b", way: 1, kind: "residential",
            width: 10, length: 100, layer: "0", bridge: "no", tunnel: "no" }],
          driving: { widths: { residential: 10 }, taxi_length: 4.7, taxi_width: 1.7 },
          elevation: { node_heights: { a: 0, b: 0 }, pilot: {}, buildings: [],
            terrain: { origin: [-10, -10], spacing: 120, width: 2, height: 2, values: [0, 0, 0, 0] } },
        };
        const canvas = document.createElement("canvas");
        document.body.append(canvas);
        const view = new Map3DView(canvas, data, []);
        try {
          const sizes = [];
          for (const graphics of ["auto", "quality", "performance", "auto"]) {
            view.applyPreferences({ ...DEFAULT_SETTINGS, graphics });
            sizes.push({ graphics, width: view.sceneTarget.width, height: view.sceneTarget.height,
              outputWidth: canvas.width, outputHeight: canvas.height, minimum: view.minimumQuality });
          }
          view.scene.clear();
          view.boundaryScene.clear();
          view.scene.fog = null;
          view.scene.background.set("#000000");
          view.lens = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10);
          view.lens.position.z = 2;
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.Float32BufferAttribute([
            -.8, -.7, 0, .8, -.61, 0, -.33, .8, 0,
          ], 3));
          const material = new THREE.MeshBasicMaterial({ color: "#ffffff" });
          view.scene.add(new THREE.Mesh(geometry, material));
          view.drawScene();
          const capture = document.createElement("canvas");
          capture.width = canvas.width; capture.height = canvas.height;
          const context = capture.getContext("2d");
          context.drawImage(canvas, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let brightest = 0, partialPixels = 0;
          for (let i = 0; i < pixels.length; i += 4) brightest = Math.max(brightest, pixels[i]);
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] > 0 && pixels[i] < brightest - 1) partialPixels++;
          }
          geometry.dispose(); material.dispose();
          return { sizes, partialPixels, pixelRatio: view.renderer.getPixelRatio(), samples: view.sceneTarget.samples,
            maxSamples: view.renderer.capabilities.maxSamples };
        } finally {
          view.dispose();
          view.renderer.forceContextLoss();
          canvas.remove();
        }
      });
      for (const size of result.sizes.filter(size => size.graphics !== "performance")) {
        expect(size.width).toBe(size.outputWidth);
        expect(size.height).toBe(size.outputHeight);
        expect(size.minimum).toBe(size.graphics === "quality" ? 1 : .55);
      }
      const performance = result.sizes.find(size => size.graphics === "performance");
      expect(performance.width).toBeLessThan(performance.outputWidth);
      expect(result.pixelRatio).toBe(density);
      expect(result.samples).toBe(Math.min(4, result.maxSamples));
      expect(result.partialPixels).toBeGreaterThan(100);
    });
  });
}

for (const density of [1, 2, 3]) {
  test.describe(`map at ${density}x pixel density`, () => {
    test.use({ deviceScaleFactor: density });

    test("matches native resolution at every zoom and reuses a bounded scrolling cache", async ({ page }, testInfo) => {
      await page.goto("/");
      await expect(page.locator("#start")).toBeEnabled();
      await page.locator("#start").click();
      await expect(page.locator("#welcome")).not.toBeVisible();
      const results = await page.evaluate(async () => {
        const { MapView } = await import("/map.mjs?v=streaming-map-1");
        const data = await (await fetch("/api/map")).json();
        const view = new MapView(document.createElement("canvas"), data, []);
        const [left, top, right, bottom] = data.bounds;
        const car = { x: (left + right) / 2, y: (top + bottom) / 2, heading: 0 };
        let builds = 0, image;
        const build = view.buildBackdrop.bind(view);
        view.buildBackdrop = (...args) => { builds++; build(...args); };
        const drawImage = view.ctx.drawImage.bind(view.ctx);
        view.ctx.drawImage = (...args) => { image = args.slice(1); drawImage(...args); };
        const results = [];
        for (const zoom of [0.35, 1.65, 3.5, "overview"]) {
          view.overview = zoom === "overview";
          if (!view.overview) view.zoom = zoom;
          view.camera = { ...car };
          view.render(car, null, "en", null);
          const before = builds;
          view.render(car, null, "en", null);
          results.push({
            zoom, reused: builds === before, scale: view.backdropScale,
            expectedScale: (view.overview
              ? Math.min((view.width - (view.width > 800 ? 370 : 25)) / (right - left),
                (view.height - 180) / (bottom - top))
              : zoom) * devicePixelRatio,
            sourceWidth: image[2], destinationWidth: image[6],
            width: view.backdrop.width, height: view.backdrop.height,
            canvasWidth: view.canvas.width, canvasHeight: view.canvas.height,
            viewportWidth: innerWidth, viewportHeight: innerHeight,
          });
        }
        view.overview = false; view.zoom = 3.5;
        view.render(car, null, "en", null);
        const beforePan = builds;
        car.x += 300 / view.zoom;
        view.camera = { ...car };
        view.render(car, null, "en", null);
        const panRebuilt = builds > beforePan;
        const beforeResize = builds;
        const densityProperty = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1.5 });
        view.render(car, null, "en", null);
        const changedDensity = {
          ratio: view.ratio, scale: view.backdropScale,
          width: view.canvas.width, rebuilt: builds > beforeResize,
        };
        Object.defineProperty(window, "devicePixelRatio", densityProperty);
        view.render(car, null, "en", null);
        view.canvas.id = "resolution-preview";
        view.canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:9999";
        document.body.append(view.canvas);
        return { results, panRebuilt, changedDensity };
      });
      for (const result of results.results) {
        expect(result.reused).toBe(true);
        expect(result.scale).toBeCloseTo(result.expectedScale, 8);
        // One cached pixel per output pixel: never enlarge a low-resolution bitmap.
        expect(result.sourceWidth / result.destinationWidth).toBeCloseTo(result.expectedScale, 8);
        expect(result.width).toBeLessThanOrEqual(Math.ceil((result.viewportWidth + 256) * density));
        expect(result.height).toBeLessThanOrEqual(Math.ceil((result.viewportHeight + 256) * density));
        expect(result.canvasWidth).toBe(Math.ceil(result.viewportWidth * density));
        expect(result.canvasHeight).toBe(Math.ceil(result.viewportHeight * density));
      }
      expect(results.panRebuilt).toBe(true);
      expect(results.changedDensity.rebuilt).toBe(true);
      expect(results.changedDensity.ratio).toBe(1.5);
      expect(results.changedDensity.scale).toBe(3.5 * 1.5);
      expect(results.changedDensity.width).toBe(Math.ceil(page.viewportSize().width * 1.5));
      await page.locator("#resolution-preview").screenshot({ path: testInfo.outputPath("sharp-map.png") });
    });
  });
}
