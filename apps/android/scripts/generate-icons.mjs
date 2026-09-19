/** Generate the Android vector drawable from the desktop's shared SVG artwork. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = new URL('../../../frontends/dsh/src/clawmaster.svg', import.meta.url);
const target = new URL('../app/src/main/res/drawable/ic_clawmaster.xml', import.meta.url);
const svg = readFileSync(source, 'utf8');
const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
const paths = [...svg.matchAll(/<path\s+([^>]+)\/>/g)];
if (!viewBox || paths.length !== 1 || /<(?:g|use|rect|circle|ellipse|polygon|polyline|line)\b|\btransform=/.test(svg)) {
  throw new Error('Shared artwork requires an Android vector converter update');
}
const attributes = Object.fromEntries([...paths[0][1].matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
if (Object.keys(attributes).some(key => !['fill', 'fill-rule', 'd'].includes(key))
  || attributes.fill !== '#000' || attributes['fill-rule'] !== 'evenodd' || !attributes.d) {
  throw new Error('Shared artwork uses unsupported path attributes');
}
const data = attributes.d.replace(/\s+/g, ' ').trim();
const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated from frontends/dsh/src/clawmaster.svg by apps/android/scripts/generate-icons.mjs. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="${viewBox[1]}" android:viewportHeight="${viewBox[2]}">
    <path android:fillColor="#000000" android:fillType="evenOdd" android:pathData="${data}"/>
</vector>
`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== xml) throw new Error('Android icon differs from shared desktop artwork; run apps/android/scripts/generate-icons.mjs');
} else {
  writeFileSync(target, xml);
}
console.log(`Shared Android icon ${process.argv.includes('--check') ? 'verified' : 'generated'}: ${fileURLToPath(target)}`);
