import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../web/vendor/three/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ["three.module.min.js", "three.core.min.js"]) {
  await copyFile(new URL(`../node_modules/three/build/${name}`, import.meta.url), new URL(name, destination));
}
await copyFile(new URL("../node_modules/three/LICENSE", import.meta.url), new URL("LICENSE", destination));
