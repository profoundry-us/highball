// The MCP server's tool list, driven over an in-memory transport: which
// tools a host that renders the widget sees, and which a plain host sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createServer } from "../lib/mcp.js";

async function toolsFor(capabilities) {
  const [ clientSide, serverSide ] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverSide);
  const client = new Client({ name: "test-host", version: "0.0.0" }, { capabilities });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return Object.fromEntries(tools.map((tool) => [ tool.name, tool ]));
}

// Starting a run is the hooks' job; run_checks exists for the widget's
// re-run buttons, so the model never gets it as a tool.
test("a host that renders the widget gets run_checks as an app-only tool", async () => {
  const tools = await toolsFor({
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [ RESOURCE_MIME_TYPE ] } }
  });
  assert.deepEqual(Object.keys(tools).sort(), [ "get_run", "list_runs", "run_checks" ]);
  assert.deepEqual(tools.run_checks._meta.ui.visibility, [ "app" ]);
  assert.equal(tools.list_runs._meta.ui.visibility, undefined, "reading stays open to the model");
});

test("a host with no widget doesn't get run_checks at all", async () => {
  const tools = await toolsFor({});
  assert.deepEqual(Object.keys(tools).sort(), [ "get_run", "list_runs" ]);
});
