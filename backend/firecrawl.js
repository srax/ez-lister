'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function scrapeWithFirecrawl(url, options = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('A valid http(s) URL is required.');
  }

  const outputPath = path.join(os.tmpdir(), `ezlist-firecrawl-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const args = [
    'scrape',
    url,
    '--only-main-content',
    '--wait-for',
    String(options.waitForMs || 3000),
    '--format',
    'markdown,links',
    '-o',
    outputPath
  ];

  await run('firecrawl', args, { timeoutMs: options.timeoutMs || 90000 });

  const raw = await fs.readFile(outputPath, 'utf8');
  await fs.unlink(outputPath).catch(() => {});
  const parsed = tryParseJson(raw);
  return {
    raw: parsed || raw,
    markdown: collectMarkdown(parsed || raw),
    links: collectLinks(parsed || raw),
    images: collectImages(parsed || raw)
  };
}

function run(command, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`firecrawl timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const message = Buffer.concat(stderr).toString('utf8') || Buffer.concat(stdout).toString('utf8');
      reject(new Error(`firecrawl exited with ${code}: ${message.slice(0, 1200)}`));
    });
  });
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectMarkdown(value) {
  const chunks = [];
  visit(value, (key, item) => {
    if (typeof item !== 'string') return;
    if (['markdown', 'content', 'text'].includes(String(key).toLowerCase())) chunks.push(item);
  });
  if (!chunks.length && typeof value === 'string') chunks.push(value);
  return chunks.join('\n\n');
}

function collectLinks(value) {
  const links = [];
  visit(value, (key, item) => {
    if (String(key).toLowerCase() === 'links' && Array.isArray(item)) {
      for (const link of item) {
        if (typeof link === 'string') links.push(link);
        if (link && typeof link === 'object' && link.url) links.push(link.url);
      }
    }
  });
  return [...new Set(links)];
}

function collectImages(value) {
  const markdown = collectMarkdown(value);
  const links = collectLinks(value);
  const imageUrls = [];

  for (const match of markdown.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    imageUrls.push(cleanMarkdownUrl(match[1]));
  }

  for (const link of links) {
    if (/\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(link) || /inventoryphotos/i.test(link)) {
      imageUrls.push(link);
    }
  }

  return [...new Set(imageUrls)]
    .filter(Boolean)
    .slice(0, 30)
    .map((url) => ({ url }));
}

function cleanMarkdownUrl(url) {
  return String(url || '')
    .replace(/&amp;/g, '&')
    .replace(/\\\)/g, ')')
    .trim();
}

function visit(value, callback, key = '') {
  callback(key, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, callback, String(index)));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, callback, childKey);
    }
  }
}

module.exports = {
  scrapeWithFirecrawl
};
