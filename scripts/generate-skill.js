import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { skillText } from '../src/guidance.js';

const target = new URL('../skills/posthog-axi/SKILL.md', import.meta.url);
const content = skillText();
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8').catch(() => '')) !== content) {
    console.error('Generated skill is stale. Run npm run generate.');
    process.exitCode = 1;
  }
} else {
  await mkdir(new URL('.', target), { recursive: true });
  await writeFile(target, content);
}
