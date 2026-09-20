import fs from 'node:fs/promises';
import path from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';

const buildDir = path.resolve('build');
const nodesDir = path.join(buildDir, '_app', 'immutable', 'nodes');

const options = {
  target: 'browser',
  compact: true,

  // Deliberately disabled: these can interfere with framework-generated
  // event handlers/control flow and were the source of the previous
  // production regression.
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  selfDefending: false,
  renameGlobals: false,
  renameProperties: false,

  // Conservative protection for application component chunks.
  simplify: true,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: [],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 2,
  stringArrayWrappersType: 'variable',
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false,
  sourceMap: false,
};

async function collectJs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJs(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

try {
  await fs.access(buildDir);
  await fs.access(nodesDir);
} catch {
  throw new Error(
    `Expected SvelteKit output at ${nodesDir}. Run a normal Vite build before obfuscation.`
  );
}

const files = await collectJs(nodesDir);

if (files.length === 0) {
  throw new Error(`No JavaScript node chunks found under ${nodesDir}.`);
}

for (const file of files) {
  const source = await fs.readFile(file, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(source, options);
  await fs.writeFile(file, result.getObfuscatedCode(), 'utf8');
}

console.log(`Protected ${files.length} SvelteKit application chunk(s).`);
console.log('Framework/runtime chunks were intentionally left untouched.');
