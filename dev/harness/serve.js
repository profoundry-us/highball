// Widget dev harness server: `npm run harness`, open http://localhost:3777.
// Serves the REAL assets/dashboard.html (edit it, reload, no Claude
// Desktop restart) inside a host-role page that speaks the MCP Apps
// postMessage dialect, with LIVE journal data plus one synthetic failed
// run so the failure UI is always visible. Dev-only — not shipped in the
// npm package (see package.json "files").
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { journaledProjects, readRuns } from "../../lib/journal.js";

const PORT = Number(process.env.PORT || 3777);
const HERE = (name) => fileURLToPath(new URL(name, import.meta.url));
const DASHBOARD = fileURLToPath(new URL("../../assets/dashboard.html", import.meta.url));

const SYNTHETIC_FAILURE = {
  started_at: new Date(Date.now() - 26 * 3600e3).toISOString(),
  duration_ms: 14200,
  trigger: "stop",
  branch: "demo/failure-preview",
  commit: "0000000",
  status: "failed",
  reported_run_id: null,
  results: [
    { id: "lint", name: "Lint & formatting", status: "passed",
      duration_ms: 2100, output_tail: "78 files inspected, no offenses detected" },
    { id: "unit-tests", name: "Unit tests", status: "failed", duration_ms: 9400,
      output_tail: "Failures:\n\n  1) the widget shows this pre-opened\n" +
        "     Failure/Error: expect(reality).to eq(hopes)\n\n44 examples, 1 failure" },
    { id: "coverage-ratchet", name: "Coverage never decreases", status: "todo",
      duration_ms: null, output_tail: null }
  ]
};

function dataScript() {
  const data = {};
  for (const project of journaledProjects()) {
    data[project] = readRuns(project).map((run, i) => ({ index: i + 1, ...run }));
  }
  const projects = Object.keys(data);
  if (projects.length === 0) data.demo = [];
  const first = projects[0] || "demo";
  data[first].push({ index: data[first].length + 1, ...SYNTHETIC_FAILURE });
  return `window.DEMO_DATA = ${JSON.stringify(data)};\n`;
}

createServer((request, response) => {
  const respond = (type, body) => {
    response.writeHead(200, { "Content-Type": type });
    response.end(body);
  };
  if (request.url === "/" || request.url === "/index.html") {
    return respond("text/html", readFileSync(HERE("index.html")));
  }
  if (request.url === "/dashboard.html") {
    return respond("text/html", readFileSync(DASHBOARD));
  }
  if (request.url === "/data.js") {
    return respond("text/javascript", dataScript());
  }
  response.writeHead(404).end("not found");
}).listen(PORT, () => {
  console.log(`widget harness: http://localhost:${PORT}`);
  console.log("serving live assets/dashboard.html + live journal data");
});
