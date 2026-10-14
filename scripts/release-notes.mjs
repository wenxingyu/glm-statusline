import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseNotes(changelog, tag) {
  const version = tag.replace(/^v/, '');
  const headings = [...changelog.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  const matches = headings.filter((heading) => heading[1].startsWith(`${version} - `));
  if (matches.length !== 1) throw new Error(`CHANGELOG.md 必须包含唯一的 ${version} 版本条目`);
  const heading = matches[0];
  const next = headings[headings.indexOf(heading) + 1];
  const body = changelog.slice(heading.index + heading[0].length, next?.index).trim();
  if (!body) throw new Error(`CHANGELOG.md 的 ${version} 版本说明不能为空`);
  return `${body}\n`;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const changelog = await fs.readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    process.stdout.write(releaseNotes(changelog, process.argv[2] || pkg.version));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
