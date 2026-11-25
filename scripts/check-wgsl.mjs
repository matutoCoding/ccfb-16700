import { readFile } from 'node:fs/promises';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';

const files = ['src/gpu/insolationShader.ts', 'src/gpu/sceneRenderer.ts'];
let failed = false;
for (const file of files) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const matches = [...source.matchAll(/(?:export )?const [A-Z_]+ = \/\* wgsl \*\/ `([\s\S]*?)`;/g)];
  for (const [i, match] of matches.entries()) {
    try {
      const reflect = new WgslReflect(match[1]);
      console.log(`OK ${file}#${i + 1}: compute=${reflect.entry.compute.length} vertex=${reflect.entry.vertex.length} fragment=${reflect.entry.fragment.length}`);
    } catch (err) {
      failed = true;
      console.error(`FAIL ${file}#${i + 1}`);
      console.error(err.message);
    }
  }
}
process.exit(failed ? 1 : 0);
