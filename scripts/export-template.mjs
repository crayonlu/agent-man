#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const destinationArgument = process.argv[2];
if (destinationArgument === undefined) {
  console.error("Usage: npm run template:export -- <empty-directory>");
  process.exitCode = 1;
} else {
  const destination = resolve(destinationArgument);
  if (existsSync(destination) && readdirSync(destination).length > 0) {
    console.error(`Template destination is not empty: ${destination}`);
    process.exitCode = 1;
  } else {
    mkdirSync(destination, { recursive: true });
    copyFileSync("templates/config-repository/gitignore", resolve(destination, ".gitignore"));
    copyFileSync(
      "templates/config-repository/gitattributes",
      resolve(destination, ".gitattributes"),
    );
    copyFileSync("templates/config-repository/README.md", resolve(destination, "README.md"));
    console.log(`Exported configuration template to ${destination}`);
  }
}
