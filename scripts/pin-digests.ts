#!/usr/bin/env bun
// pin-digests — resolve `sha256:PIN:<program>` placeholders and stale digests
// in repeat/each/organism cells to the canonical digest of the named inner
// program. Inner programs are pinned before the programs that embed them.
// Run after editing any embedded program; `scripts/check.ts` fails when a
// pinned digest is stale.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestCanonical, manifestToJson, parseOrganismManifest } from "@hraness/algal";

const PROGRAMS = join(new URL("..", import.meta.url).pathname, "programs");
const EMBEDS = new Map<string, string>([
  ["profile-stat-read.algal.json:attempts", "profile-stat-attempt"],
  ["profile-stats.algal.json:collect", "profile-stat-read"],
]);
const ORDER = ["profile-stat-attempt", "profile-stat-read", "profile-stats"];

export function canonicalDigest(id: string): string {
  const manifest = parseOrganismManifest(JSON.parse(readFileSync(join(PROGRAMS, `${id}.algal.json`), "utf8")));
  return digestCanonical(manifestToJson(manifest));
}

export function pinAll(mode: "apply" | "check"): { stale: string[] } {
  const stale: string[] = [];
  const files = readdirSync(PROGRAMS).filter((file) => file.endsWith(".algal.json"))
    .sort((a, b) => ORDER.indexOf(a.replace(".algal.json", "")) - ORDER.indexOf(b.replace(".algal.json", "")));
  for (const file of files) {
    const path = join(PROGRAMS, file);
    const text = readFileSync(path, "utf8");
    const manifest = JSON.parse(text) as { cells: Array<{ id: string; manifest?: string }> };
    let next = text;
    for (const cell of manifest.cells) {
      const inner = EMBEDS.get(`${file}:${cell.id}`);
      if (!inner || cell.manifest === undefined) continue;
      const digest = canonicalDigest(inner);
      if (cell.manifest !== digest) {
        stale.push(`${file}:${cell.id} → ${inner}`);
        next = next.replace(`"manifest": "${cell.manifest}"`, `"manifest": "${digest}"`);
      }
    }
    if (mode === "apply" && next !== text) writeFileSync(path, next);
  }
  return { stale };
}

if (import.meta.main) {
  const mode = process.argv.includes("--check") ? "check" : "apply";
  const { stale } = pinAll(mode);
  if (mode === "check" && stale.length > 0) {
    console.error(`stale digests:\n${stale.join("\n")}`);
    process.exit(1);
  }
  console.log(stale.length === 0 ? "digests current" : `pinned ${stale.length} digest(s)`);
}
