/**
 * test-rag-sync.mjs
 * Mock test for rag-sync.ts plugin.
 */
import { mockCtx } from "/home/leonid/opencode-env/mock-ctx.mjs";
import plugin from "/home/leonid/.config/opencode/plugins/rag-sync.ts";

async function main() {
  console.log("--- Testing rag-sync.ts setup ---");
  const ctx = mockCtx();
  
  const { setup } = plugin;
  const dispose = await setup(ctx);
  
  console.log("Plugin setup successful.");
  
  // Check tools registered in ctx.tool
  console.log("\n--- Registered Tools ---");
  const tools = ctx.tool.tools;
  const ragTools = tools.filter(t => t.namespace === "rag");
  
  if (ragTools.length === 0) {
    console.error("❌ No 'rag' namespace tools found!");
    process.exit(1);
  }

  const names = ragTools.map(t => t.name);
  console.log("Names:", names);
  
  const expected = ["rag_search", "rag_where", "rag_index", "rag_stats", "rag_project", "rag_summary", "kb_read", "kb_add"];
  for (const name of expected) {
    if (!names.includes(name)) {
      console.error(`❌ Missing tool: ${name}`);
      process.exit(1);
    }
  }
  console.log("✅ All expected tools are registered.");

  // Check hook
  console.log("\n--- Checking context hook ---");
  const hook = ctx.session.hooks.get("context");
  if (!hook) {
    console.error("❌ 'context' hook not registered.");
    process.exit(1);
  }
  console.log("✅ 'context' hook is registered.");

  if (dispose) {
    dispose();
    console.log("\nDispose function executed.");
  }
  console.log("\n✅ Mock test passed.");
}

main().catch(console.error);
