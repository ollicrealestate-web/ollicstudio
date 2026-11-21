// Minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
// No outside packages, so the hub runs on any Node 18+ (including the Node built into Claude Desktop).

export const S = {
  num: (description) => ({ type: "number", ...(description && { description }) }),
  str: (description) => ({ type: "string", ...(description && { description }) }),
  bool: (description) => ({ type: "boolean", ...(description && { description }) }),
  enm: (values, description) => ({ type: "string", enum: values, ...(description && { description }) }),
  arr: (items, description, extra) => ({ type: "array", items, ...(description && { description }), ...extra }),
  obj: (properties, required = [], description) => ({ type: "object", properties, ...(required.length && { required }), ...(description && { description }) }),
  any: (types, description) => ({ type: types, ...(description && { description }) }),
};

export class McpServer {
  constructor({ name, version, instructions }) {
    this.info = { name, version };
    this.instructions = instructions;
    this.tools = new Map();
  }

  tool(name, description, inputSchema, handler) {
    this.tools.set(name, { def: { name, description, inputSchema: { type: "object", properties: {}, ...inputSchema } }, handler });
  }

  async handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => (id === undefined ? null : { jsonrpc: "2.0", id, result });
    const error = (code, message) => (id === undefined ? null : { jsonrpc: "2.0", id, error: { code, message } });
    switch (method) {
      case "initialize":
        return reply({
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
          instructions: this.instructions,
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: [...this.tools.values()].map((t) => t.def) });
      case "tools/call": {
        const t = this.tools.get(params?.name);
        if (!t) return error(-32602, `Unknown tool: ${params?.name}`);
        try {
          const out = await t.handler(params.arguments || {});
          return reply(out);
        } catch (e) {
          return reply({ isError: true, content: [{ type: "text", text: e.message || String(e) }] });
        }
      }
      default:
        return method?.startsWith("notifications/") ? null : error(-32601, `Method not found: ${method}`);
    }
  }

  listen(input = process.stdin, output = process.stdout) {
    let buf = "";
    input.setEncoding("utf8");
    const write = (obj) => obj && output.write(JSON.stringify(obj) + "\n");
    input.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
        const batch = Array.isArray(msg) ? msg : [msg];
        for (const m of batch) this.handle(m).then(write, (e) => write({ jsonrpc: "2.0", id: m.id ?? null, error: { code: -32603, message: e.message } }));
      }
    });
    input.on("end", () => process.exit(0));
  }
}
