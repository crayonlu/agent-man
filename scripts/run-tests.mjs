#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

function collectTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      tests.push(path);
    }
  }
  return tests;
}

function compiledPath(argument) {
  const absolute = resolve(argument);
  const sourceRelative = relative(process.cwd(), absolute);
  const extension = extname(sourceRelative);
  const withoutExtension = sourceRelative.slice(0, sourceRelative.length - extension.length);
  return resolve("dist", `${withoutExtension}.js`);
}

const requested = process.argv.slice(2);
const tests =
  requested.length > 0 ? requested.map(compiledPath) : collectTests(resolve("dist/tests"));

const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
