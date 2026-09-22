import * as ragLib from "/home/leonid/opencode-env/mcp/rag-lib.mjs";

async function main() {
  const project = "/home/leonid/notix";
  console.log(`Testing project: ${project}`);

  // 1. Indexing
  console.log("Starting indexing...");
  const cmd = `node /home/leonid/opencode-env/mcp/build-index.mjs --project ${project}`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log("Indexing successful.");
  } catch (e) {
    console.error("Indexing failed.");
    process.exit(1);
  }

  // 2. Search
  console.log("\nTesting search...");
  const idx = ragLib.load("notix");
  const results = await ragLib.search(idx, "how to use opencode", 3);
  console.log("Search results:");
  console.log(results);

  if (!results || results.length === 0) {
    console.error("Search returned no results.");
    process.exit(1);
  }
  console.log("Search successful.");
}

import { execSync } from "node:child_process";
main().catch(console.error);
