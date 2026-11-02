#!/usr/bin/env node
// Compares the selectors and join parameters of the bots with BBB's own Playwright tests.
// Without arguments it checks the newest stable release of each line from 3.0 on.
// Usage: node scripts/check-selectors.mjs [v3.0.40 v4.0.1 ...]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = 'bigbluebutton/bigbluebutton';
const TESTS = 'bigbluebutton-tests/playwright';

/** The strings a selector needs in BBB's elements file. A comma separates alternatives. */
export function selectorTokens(selector) {
  return selector.split(',').map((alternative) => {
    const attribute = /data-test(?:id)?="([^"]+)"/.exec(alternative);
    if (attribute) return [attribute[1]];
    const id = /#([\w-]+)/.exec(alternative);
    return id ? [id[1]] : [alternative.trim()];
  });
}

export function missingSelectors(selectors, elementsSource) {
  return Object.entries(selectors)
    .filter(([, selector]) => !selectorTokens(selector).some((tokens) => tokens.every((token) => elementsSource.includes(`"${token}"`) || elementsSource.includes(`#${token}`))))
    .map(([name, selector]) => ({ name, selector }));
}

export const missingParameters = (parameters, source) => parameters.filter((p) => !source.includes(p));

/** Newest stable tag per major.minor line, without betas and release candidates. */
export function latestReleases(tags, minimum = [3, 0]) {
  const lines = new Map();
  for (const tag of tags) {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (!m) continue;
    const [major, minor, patch] = m.slice(1).map(Number);
    if (major < minimum[0] || (major === minimum[0] && minor < minimum[1])) continue;
    const line = `${major}.${minor}`;
    if (!lines.has(line) || lines.get(line).patch < patch) lines.set(line, { tag, patch });
  }
  return [...lines.values()].map((v) => v.tag);
}

function remoteTags() {
  return execFileSync('git', ['ls-remote', '--tags', '--refs', `https://github.com/${REPO}.git`], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.split('refs/tags/')[1])
    .filter(Boolean);
}

async function source(tag, path) {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/${TESTS}/${path}`);
  if (!res.ok) throw new Error(`${tag}/${path}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const { ui, joinParameters } = await import('../src/bot/selectors.ts');
  const tags = process.argv.slice(2).length ? process.argv.slice(2) : latestReleases(remoteTags());
  let broken = false;
  for (const tag of tags) {
    const selectors = missingSelectors(ui, await source(tag, 'core/elements.ts'));
    const parameters = missingParameters(joinParameters, await source(tag, 'parameters/constants.ts'));
    const ok = selectors.length === 0 && parameters.length === 0;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${tag}`);
    for (const { name, selector } of selectors) console.log(`     selector ${name}: ${selector}`);
    for (const parameter of parameters) console.log(`     join parameter ${parameter}`);
    broken ||= !ok;
  }
  process.exitCode = broken ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
