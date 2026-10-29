import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const destination = new URL("../web/vendor/three/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ["three.module.min.js", "three.core.min.js"]) {
  await copyFile(new URL(`../node_modules/three/build/${name}`, import.meta.url), new URL(name, destination));
}
await copyFile(new URL("../node_modules/three/LICENSE", import.meta.url), new URL("LICENSE", destination));

const clipping = new URL("../web/vendor/polygon-clipping/", import.meta.url);
await mkdir(clipping, { recursive: true });
const source = await readFile(new URL("../node_modules/polygon-clipping/dist/polygon-clipping.umd.min.js", import.meta.url), "utf8");
await writeFile(new URL("polygon-clipping.mjs", clipping),
  `const module = { exports: {} };\nconst exports = module.exports;\n${source}\nexport default module.exports;\n`);
const polygonLicense = await readFile(new URL("../node_modules/polygon-clipping/LICENSE.md", import.meta.url), "utf8");
const splayReadme = await readFile(new URL("../node_modules/splaytree/Readme.md", import.meta.url), "utf8");
const licenseStart = splayReadme.indexOf("The MIT License (MIT)");
if (licenseStart < 0) throw new Error("Cannot locate the splaytree licence");
const predicatesLicense = await readFile(new URL("../node_modules/robust-predicates/LICENSE", import.meta.url), "utf8");
await writeFile(new URL("LICENSE.md", clipping),
  `${polygonLicense}\n\n## Bundled splaytree\n\n${splayReadme.slice(licenseStart)}\n\n## Bundled robust-predicates\n\n${predicatesLicense}`);
