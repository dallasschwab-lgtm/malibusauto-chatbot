// @ts-nocheck
import http from "http";
import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";

const SM_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjaWQiOiI2NDM3NDExYjA3Yjg3ZDAwMjQwNzhlZDEiLCJpYXQiOjE3ODI2NjQ3NTMsImlkIjoiNjQzNzQxMWIwN2I4N2QwMDI0MDc4ZWQzIiwibGlkIjoiNjQzNzQxMWIwN2I4N2QwMDI0MDc4ZWQxIiwicCI6ImFwaSIsInJpZCI6InVjMSIsInNhZCI6MCwic2lkIjoiNTgyNTA0ODgwNjk3MjMxMyIsInRjaWQiOiI2NDM3NDExYjA3Yjg3ZDAwMjQwNzhlZDEiLCJkYXRhU2hhcmluZyI6ZmFsc2UsImhhc0hxIjpmYWxzZSwib25iIjo3LCJwYXkiOjMsImF1ZCI6ImFwaSIsImlzcyI6Imh0dHBzOi8vYXBpLnNob3Btb25rZXkuY2xvdWQiLCJleHAiOjQ5Mzg0MjQ3NTN9.LKPGInLMmdEV70anTfRIoolEurgkK7qt7-G5q8mB5mc";
const BASE = "https://api.shopmonkey.cloud/v3";
const PORT = process.env.PORT || 3000;

async function sm(path, method = "GET", body = null) {
  const opts = { method, headers: { Authorization: `Bearer ${SM_TOKEN}`, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json();
  if (!res.ok || json.success === false) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data ?? json;
}

const TOOLS = [
  { name: "sm_get_company", description: "Get Malibu's Auto Center company info from ShopMonkey.", inputSchema: { type: "object", properties: {} } },
  { name: "sm_list_customers", description: "List customers from ShopMonkey. Optional: search (name/phone/email), limit.", inputSchema: { type: "object", properties: { search: { type: "string" }, limit: { type: "number" } } } },
  { name: "sm_get_customer", description: "Get full customer details by ID.", inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" } } } },
  { name: "sm_create_customer", description: "Create a new customer in ShopMonkey.", inputSchema: { type: "object", required: ["first_name", "last_name"], properties: { first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, notes: { type: "string" } } } },
  { name: "sm_list_orders", description: "List work orders. Optional status: open|in_progress|completed|waiting_for_parts|all", inputSchema: { type: "object", properties: { status: { type: "string" }, customer_id: { type: "string" }, limit: { type: "number" } } } },
  { name: "sm_get_order", description: "Get full work order details by ID.", inputSchema: { type: "object", required: ["order_id"], properties: { order_id: { type: "string" } } } },
  { name: "sm_add_order_note", description: "Add a note to a work order.", inputSchema: { type: "object", required: ["order_id", "note"], properties: { order_id: { type: "string" }, note: { type: "string" } } } },
  { name: "sm_list_vehicles", description: "List vehicles. Optional: customer_id, limit.", inputSchema: { type: "object", properties: { customer_id: { type: "string" }, limit: { type: "number" } } } },
  { name: "sm_list_inventory", description: "List parts/inventory. Optional: search, limit.", inputSchema: { type: "object", properties: { search: { type: "string" }, limit: { type: "number" } } } },
];

async function callTool(name, args) {
  switch (name) {
    case "sm_get_company": return JSON.stringify(await sm("/company"), null, 2);
    case "sm_list_customers": {
      let path = `/customer?limit=${args.limit || 25}&sort=updatedDate&order=DESC`;
      if (args.search) path += `&q=${encodeURIComponent(args.search)}`;
      const d = await sm(path); const items = Array.isArray(d) ? d : (d.data || []);
      return JSON.stringify(items.map(c => ({ id: c.id, name: `${c.firstName || ""} ${c.lastName || ""}`.trim(), email: c.email, phone: c.phone, vehicles: c.vehicleCount ?? 0, lastVisit: c.updatedDate })), null, 2);
    }
    case "sm_get_customer": return JSON.stringify(await sm(`/customer/${args.customer_id}`), null, 2);
    case "sm_create_customer": {
      const d = await sm("/customer", "POST", { firstName: args.first_name, lastName: args.last_name, email: args.email || null, phone: args.phone || null, note: args.notes || null });
      return JSON.stringify({ success: true, customer_id: d.id });
    }
    case "sm_list_orders": {
      let path = `/order?limit=${args.limit || 25}&sort=updatedDate&order=DESC`;
      if (args.status && args.status !== "all") path += `&status=${args.status}`;
      if (args.customer_id) path += `&customerId=${args.customer_id}`;
      const d = await sm(path); const items = Array.isArray(d) ? d : (d.data || []);
      return JSON.stringify(items.map(o => ({ id: o.id, number: o.number, status: o.status, customer: o.customerName || o.customerId, vehicle: o.vehicleName || null, total: o.totalAmountCents ? `$${(o.totalAmountCents / 100).toFixed(2)}` : null, updated: o.updatedDate })), null, 2);
    }
    case "sm_get_order": return JSON.stringify(await sm(`/order/${args.order_id}`), null, 2);
    case "sm_add_order_note": await sm(`/order/${args.order_id}/note`, "POST", { note: args.note }); return JSON.stringify({ success: true });
    case "sm_list_vehicles": {
      let path = `/vehicle?limit=${args.limit || 25}`;
      if (args.customer_id) path += `&customerId=${args.customer_id}`;
      const d = await sm(path); const items = Array.isArray(d) ? d : (d.data || []);
      return JSON.stringify(items.map(v => ({ id: v.id, year: v.year, make: v.make, model: v.model, color: v.color, vin: v.vin, plate: v.plate })), null, 2);
    }
    case "sm_list_inventory": {
      let path = `/inventory?limit=${args.limit || 25}`;
      if (args.search) path += `&q=${encodeURIComponent(args.search)}`;
      const d = await sm(path); const items = Array.isArray(d) ? d : (d.data || []);
      return JSON.stringify(items.map(i => ({ id: i.id, name: i.name, partNumber: i.partNumber, quantity: i.quantityOnHand, price: i.retailPriceCents ? `$${(i.retailPriceCents / 100).toFixed(2)}` : null })), null, 2);
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const sessions = new Map();

const CHAT_SYSTEM = `You are a friendly AI assistant for Malibu's Auto Center, a full-service auto repair shop in Moore, Oklahoma.

You help website visitors by:
- Answering questions about services, general pricing, and hours
- Checking the status of their vehicle (ask for their name or phone number, look them up in the system)
- Capturing new customer info and service requests (add them to the system)
- Taking messages / callback requests

About the shop:
- Name: Malibu's Auto Center, Moore, Oklahoma
- Services: Full auto repair and maintenance — oil changes, brakes, engine, diagnostics, tires, AC, transmission, and more

When a customer asks about their vehicle:
1. Ask for their name or phone number
2. Search with sm_list_customers
3. Get their orders with sm_list_orders using their customer_id
4. Give a clear, friendly status update

When a new customer submits a request, create them with sm_create_customer and let them know someone will follow up.

Keep responses short (2-4 sentences). Be warm and professional. Never make up prices or promise timing.`;

const CLAUDE_TOOLS = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

async function runChat(sessionId, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const anthropic = new Anthropic({ apiKey });
  if (!sessions.has(sessionId)) sessions.set(sessionId, []);
  const history = sessions.get(sessionId);
  history.push({ role: "user", content: userMessage });
  const messages = history.slice(-20);
  let response;
  while (true) {
    response = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 512, system: CHAT_SYSTEM, messages, tools: CLAUDE_TOOLS });
    if (response.stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          let result;
          try { result = await callTool(block.name, block.input); } catch (e) { result = JSON.stringify({ error: e.message }); }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    } else { break; }
  }
  const text = response.content.find(b => b.type === "text")?.text || "Please call us directly for help!";
  history.push({ role: "assistant", content: text });
  if (history.length > 40) sessions.set(sessionId, history.slice(-20));
  return text;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, Accept");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "DELETE") { res.writeHead(200); res.end(); return; }
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (req.method === "POST" && pathname === "/chat") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end("Bad JSON"); return; }
    try {
      const reply = await runChat(body.sessionId || "anon", body.message || "");
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ reply }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ reply: "Something went wrong — please call us!", error: e.message }));
    }
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "shopmonkey-mcp", version: "1.0.0", protocol: "mcp", status: "ok", chatbot: "enabled" }));
    return;
  }

  if (req.method === "POST") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let msg; try { msg = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400); res.end("Bad JSON"); return; }
    const messages = Array.isArray(msg) ? msg : [msg];
    const responses = [];
    for (const m of messages) {
      const id = m.id ?? null; const method = m.method || "";
      try {
        if (method === "initialize") { responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: m.params?.protocolVersion || "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "shopmonkey-mcp", version: "1.0.0" } } }); }
        else if (method === "notifications/initialized" || method === "ping") { if (id !== null) responses.push({ jsonrpc: "2.0", id, result: {} }); }
        else if (method === "tools/list") { responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); }
        else if (method === "tools/call") { const { name, arguments: args } = m.params || {}; const text = await callTool(name, args || {}); responses.push({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }); }
        else { if (id !== null) responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }); }
      } catch (e) { if (id !== null) responses.push({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message } }); }
    }
    const responseBody = responses.length === 1 ? JSON.stringify(responses[0]) : JSON.stringify(responses);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(responseBody); return;
  }

  res.writeHead(405); res.end("Method not allowed");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ShopMonkey MCP + Chatbot running on port ${PORT}`);
});
