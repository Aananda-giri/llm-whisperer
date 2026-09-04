#!/usr/bin/env node
// Structural checks for the wiki/ book. Zero dependencies.
//
//   node wiki/check.mjs
//
// Asserts what a machine can: links resolve, anchors exist, pages are reachable
// from the contents, every page has an H1 + status banner + nav footer, banners
// use the closed marker vocabulary, and every §7 register row links to a page.
//
// What it CANNOT check is whether a "Status:" line is still true. That is on
// whoever changes the code. See 8-about/8.1-how-this-book-is-written.md.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIKI = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(WIKI, "..");
const CONTENTS = join(WIKI, "README.md");
const REGISTER = join(WIKI, "7-status.md");

const MARKERS = ["Implemented", "Partial", "Planned", "Reference"];

const failures = [];
const fail = (file, msg) => failures.push(`${relative(REPO, file)}: ${msg}`);

// ── collect pages ──────────────────────────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

const pages = walk(WIKI).sort();
const source = new Map(pages.map((p) => [p, readFileSync(p, "utf-8")]));

// ── helpers ────────────────────────────────────────────────────────────────

/** Strip fenced code blocks so examples inside them are never parsed as prose. */
function withoutFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, "");
}

/** GitHub's heading -> anchor slug. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function anchorsOf(text) {
  const set = new Set();
  for (const m of withoutFences(text).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    set.add(slug(m[1]));
  }
  return set;
}

/** Every [text](target) link, excluding those inside code fences. */
function linksOf(text) {
  return [...withoutFences(text).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
}

// ── 1. structure: H1, banner, nav footer ───────────────────────────────────
function checkStructure(file, text) {
  const lines = text.split("\n");

  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 === -1) {
    fail(file, "no H1 heading");
    return;
  }

  // The contents page is the nav destination; it needs no footer of its own.
  if (file === CONTENTS) return;

  const footer = lines.slice(-6).join("\n");
  if (!/\[Contents\]\(/.test(footer)) {
    fail(file, "no nav footer linking to Contents in the last 6 lines");
  }
}

// ── 2. banner: present, and from the closed vocabulary ─────────────────────
function checkBanner(file, text) {
  const lines = text.split("\n");
  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 === -1) return; // already reported

  // The banner must appear within 3 lines of the H1.
  const window = lines.slice(h1 + 1, h1 + 4).join("\n");
  const m = window.match(/>\s*\*\*Status:\*\*\s*(\S+)/);
  if (!m) {
    fail(file, "no `> **Status:**` banner within 3 lines of the H1");
    return;
  }
  const marker = m[1].replace(/[^\w]/g, "");
  if (!MARKERS.includes(marker)) {
    fail(file, `banner marker "${marker}" is outside the vocabulary (${MARKERS.join(", ")})`);
  }
}

// ── 3. links resolve, and anchors exist ────────────────────────────────────
function checkLinksAndAnchors(file, text) {
  for (const raw of linksOf(text)) {
    if (/^(https?:|mailto:)/.test(raw)) continue;

    const [target, hash] = raw.split("#");

    if (target === "") {
      // Same-page anchor.
      if (hash && !anchorsOf(text).has(hash)) {
        fail(file, `anchor #${hash} does not exist on this page`);
      }
      continue;
    }

    const abs = resolve(dirname(file), target);
    let exists = true;
    try {
      statSync(abs);
    } catch {
      exists = false;
    }
    if (!exists) {
      fail(file, `link target does not exist: ${target}`);
      continue;
    }

    if (hash && abs.endsWith(".md")) {
      const body = source.get(abs) ?? readFileSync(abs, "utf-8");
      if (!anchorsOf(body).has(hash)) {
        fail(file, `anchor #${hash} does not exist in ${target}`);
      }
    }
  }
}

// ── 4. every page reachable from the contents ──────────────────────────────
function checkReachable() {
  const contents = source.get(CONTENTS);
  const linked = new Set([CONTENTS]);

  for (const raw of linksOf(contents)) {
    if (/^(https?:|mailto:)/.test(raw)) continue;
    const abs = resolve(WIKI, raw.split("#")[0]);
    if (abs.endsWith(".md")) linked.add(abs);
  }

  for (const page of pages) {
    if (!linked.has(page)) {
      fail(page, "not linked from wiki/README.md (the contents)");
    }
  }
}

// ── 5. every register row links to a page in this book ─────────────────────
function checkRegisterRows() {
  const text = source.get(REGISTER);
  if (!text) {
    fail(REGISTER, "the status register is missing");
    return;
  }

  let n = 0;
  for (const line of withoutFences(text).split("\n")) {
    // Data rows only: a table row that is not a header or separator.
    if (!line.startsWith("|") || /^\|\s*-+/.test(line)) continue;
    if (/^\|\s*Item\s*\|/.test(line) || /^\|\s*\|/.test(line)) continue;

    const targets = [...line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
      .map((m) => m[1])
      .filter((t) => !/^https?:/.test(t) && t.split("#")[0].endsWith(".md"));

    if (targets.length === 0) {
      fail(REGISTER, `register row links to no chapter: ${line.slice(0, 72)}…`);
      continue;
    }
    n++;
  }

  if (n === 0) fail(REGISTER, "no register rows found — did the table format change?");
  else console.log(`  ${n} register rows, each linking to an owning chapter`);
}

// ── run ────────────────────────────────────────────────────────────────────
console.log(`Checking ${pages.length} pages under wiki/\n`);

for (const page of pages) {
  const text = source.get(page);
  checkStructure(page, text);
  checkBanner(page, text);
  checkLinksAndAnchors(page, text);
}
checkReachable();
checkRegisterRows();

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} problem${failures.length === 1 ? "" : "s"}:\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log("\n✓ wiki checks passed");
console.log("  (a Status banner being *true* is not checkable — see 8.1)");
