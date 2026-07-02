// @ts-nocheck
import http from "http";
import fetch from "node-fetch";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";

const SM_TOKEN = process.env.SHOPMONKEY_API_TOKEN;
if (!SM_TOKEN) { console.error("FATAL: SHOPMONKEY_API_TOKEN env var is not set"); process.exit(1); }
const BASE = "https://api.shopmonkey.cloud/v3";
const PORT = process.env.PORT || 3000;
let requestFormsStatusId = null;

async function sm(path, method = "GET", body = null) {
  const opts = { method, headers: { Authorization: `Bearer ${SM_TOKEN}`, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json();
  if (!res.ok || json.success === false) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data ?? json;
}

async function loadWorkflowStatuses() {
  // /workflow returns { [statusId]: { name, orders, hasMore } } — parse as entries
  try {
    const data = await sm("/workflow");
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const entries = Object.entries(data) as [string, { name: string }][];
      if (entries.length > 0) {
        console.log(`✓ /workflow statuses: ${entries.map(([id, v]) => `${v.name} (${id})`).join(", ")}`);
        const found = entries.find(([, v]) => (v.name || "").toLowerCase().includes("request"));
        if (found) {
          requestFormsStatusId = found[0];
          console.log(`✓ "Request Forms" status ID: ${requestFormsStatusId}`);
        } else {
          console.log(`⚠ No "Request Forms" status found. Available: ${entries.map(([, v]) => v.name).join(", ")}`);
        }
        return;
      }
    }
    console.log(`⚠ /workflow returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  } catch (e) {
    console.log(`⚠ /workflow failed: ${(e as Error).message}`);
  }
  console.log("⚠ Could not load workflow statuses.");
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
  {
    name: "sm_create_lead_estimate",
    description: "Create a new customer AND a new estimate in ShopMonkey for a website chatbot lead. Use this whenever a customer provides their name and phone number. Saves their contact info, logs chat notes as the estimate note, and sets the estimate to 'Request Forms' workflow status so the team sees it.",
    inputSchema: {
      type: "object",
      required: ["first_name", "last_name", "phone", "customer_summary", "full_chat_transcript"],
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        customer_summary: {
          type: "string",
          description: "2-3 sentence customer-facing summary of what the customer wants. This will appear in the Customer Comments field visible to the customer. Example: 'Customer is interested in LLumar CTX window tint for their 2021 Chevy Silverado crew cab. They asked about pricing and install time. Team to follow up with a quote.'"
        },
        full_chat_transcript: {
          type: "string",
          description: "The complete conversation from start to finish, formatted as:\nCustomer: [message]\nBot: [reply]\nCustomer: [message]\nBot: [reply]\n\nInclude every single turn."
        },
      },
    },
  },
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
      const d = await sm("/customer", "POST", { firstName: args.first_name, lastName: args.last_name, email: args.email || null, phone: args.phone || null, note: args.notes || null, customerType: "individual" });
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
    case "sm_create_lead_estimate": {
      console.log("sm_create_lead_estimate called:", args.first_name, args.last_name, args.phone);

      // 1. Search for existing customer by phone to avoid duplicates
      let customerId: string | null = null;
      try {
        const search = await sm(`/customer?q=${encodeURIComponent(args.phone)}&limit=10`);
        const items = Array.isArray(search) ? search : (search.data || []);
        const clean = (p: string) => (p || "").replace(/\D/g, "");
        const match = items.find((c: any) => clean(c.phone) === clean(args.phone));
        if (match) { customerId = match.id; console.log(`✓ Existing customer found: ${match.firstName} ${match.lastName} (${match.id})`); }
      } catch (e: any) { console.log("Customer search error:", e.message); }

      // 2. Create customer only if not found
      if (!customerId) {
        const customer = await sm("/customer", "POST", {
          firstName: args.first_name,
          lastName: args.last_name,
          email: args.email || null,
          phone: args.phone || null,
          customerType: "Customer",
        });
        customerId = customer.id;
      }

      // 3. Create the estimate
      const orderBody: any = { customerId };
      if (requestFormsStatusId) orderBody.workflowStatusId = requestFormsStatusId;
      const order = await sm("/order", "POST", orderBody);

      // 4. Try complaint field for Customer Comments (Services tab)
      try { await sm(`/order/${order.id}`, "PUT", { complaint: args.customer_summary }); } catch (e: any) { console.log("complaint PUT failed:", e.message); }

      // 5. Add full transcript + summary to Notes tab
      const noteText = `Website chatbot lead — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}\n\n${args.full_chat_transcript}\n\n---\nSUMMARY: ${args.customer_summary}`;
      try { await sm(`/order/${order.id}/note`, "POST", { note: noteText }); } catch (e: any) { console.log("Note POST failed:", e.message); }

      return JSON.stringify({
        success: true,
        customer_id: customerId,
        estimate_id: order.id,
        estimate_number: order.number,
        workflow: requestFormsStatusId ? "Request Forms" : "default",
      });
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const sessions = new Map();

const CHAT_SYSTEM = `You are a knowledgeable, friendly sales and support assistant for Malibu's Auto Center in Moore, Oklahoma. Think of yourself as one of our best salespeople — you know our products inside and out and help customers find exactly what they need.

CONTACT & HOURS:
- Phone: 405-799-6700
- Hours: Monday–Friday, 9am–5pm
- Appointments preferred; walk-ins welcome if we have availability
- Most parts arrive within 1–2 business days from our distributors
- Online scheduling: https://app.shopmonkey.cloud/public/scheduler/6437411b07b87d0024078ed1?fullPage=true

LEAD CAPTURE — CRITICAL RULES:
Whenever a customer expresses genuine interest in a product or service, asks for pricing, asks about scheduling, or wants more information — ask for their name and phone number so our team can follow up. Do this naturally, not robotically. Example: "I'd love to get you a quote on that — can I grab your name and number so our team can reach out?"

Once you have their name AND phone number, you MUST call sm_create_lead_estimate BEFORE saying anything else. This is required — do not skip it, do not summarize it, do not confirm to the customer until the tool has been called and returned success.

The tool will:
1. Create them as a customer in our system
2. Create an estimate in the "Request Forms" workflow stage
3. Log the conversation as the estimate note

You must fill in two fields:
- customer_summary: Write 2-3 sentences describing what the customer wants, in plain language the customer would recognize. This is customer-facing. Example: 'Customer is interested in LLumar CTX window tint for their 2022 F-150 crew cab. They asked about heat rejection and warranty. Team to follow up with pricing.'
- full_chat_transcript: Copy the ENTIRE conversation from start to finish, formatted as:
Customer: [their exact message]
Bot: [your exact reply]
...every turn, nothing omitted.

ONLY AFTER sm_create_lead_estimate returns successfully, tell the customer: "Perfect — I've got your info saved and our team will be in touch shortly to put together a quote for you!"

IMPORTANT: Never tell a customer their info is saved unless sm_create_lead_estimate has already run and returned success. If the tool fails, say: "I'm having a technical issue saving your info right now — please call us directly at 405-799-6700 and we'll take care of you!"

SERVICES WE OFFER:

1. WINDOW TINT
We install LLumar window tint on cars, trucks, SUVs, and more. Three film options:
- LLumar ATR: Entry-level dyed film. Great for looks, glare reduction, and basic UV blocking. Most affordable.
- LLumar CTX: Mid-range ceramic film. Significantly better heat rejection. Won't interfere with phone signals, GPS, or key fobs. Doesn't fade or turn purple. Best all-around value.
- LLumar IRX: Top-of-the-line ceramic IR film. Blocks up to 95% of infrared heat. Maximum comfort, best clarity, longest lasting. Our premium option.
In plain terms: ATR = looks good on a budget; CTX = ceramic, great heat rejection; IRX = the best we carry.
NO-FAULT WARRANTY: Available as an optional add-on — not included by default. Mention it as an upgrade when relevant.

WINDOW TINT PRICING (starting at — prices may vary by vehicle complexity):
                     ATR    CTX    IRX
2 Side Roll-Ups:    $129   $159   $199
2 Door Car/Truck:   $279   $349   $429
4 Door Car/Truck:   $299   $369   $449
Full SUV:           $349   $449   $529
Full Windshield Tint: $239–$299
Visor Strip: $65
Sunroof: $99–$199
Tint Removal: $20–$179
Express Roll-Down: $19+
Gift certificates available!

*Prices subject to change based on complexity of vehicle and amount of tint required.
Install time: two windows 30–60 minutes; full vehicle varies. Customers can schedule online or we can capture their info.

WINDOW TINT CONVERSATION STYLE — IMPORTANT:
Do NOT dump the full price grid when someone asks about tint. Be consultative:
1. Ask what vehicle they have if you don't know yet
2. Ask what they're mainly looking for — heat reduction, privacy, looks, or all of the above
3. Based on their answer, recommend 1-2 film options and give only the relevant pricing
4. Keep it to 3-4 sentences. The goal is a conversation, not a brochure.

2. TRUCK BED COVERS (TONNEAU COVERS)
As an authorized RealTruck dealer, we carry the full lineup of RealTruck brands. Popular options:

BAKFlip MX4 (GEN 3) — Hard Folding | Best Seller
- Polymer-reinforced aluminum panels — 22% stronger than previous generation
- Precision-engineered aluminum side rails and frame, matte black textured finish
- Patented auto-latch system: locks automatically on closure, no separate action needed
- Edge-to-edge seals + tight-fit clamps for superior weather protection
- Folds to the cab for 100% bed access — doesn't block the 3rd brake light (industry first)
- 400 lb weight capacity (evenly distributed)
- No drilling required on most trucks; installs in under 30 minutes
- 5-year warranty, assembled in the USA (Missouri)
- Starting price: ~$1,149

RetraxPRO MX — Retractable Aluminum | Premium
- Double-wall aluminum slat construction, supports up to 500 lbs
- Exclusive CoreTrax™ sealed rollers — opens and closes with one finger
- Key-lockable TraxLatch™ handle locks in unlimited positions
- Can be left open anywhere in the bed — cinch gear between cover and tailgate
- Opens and closes completely independently of the tailgate
- Premium matte black powder coat finish
- Tested -40°F to 180°F, up to 95% humidity — won't freeze or bind
- Integrated water management system keeps cargo dry
- No-drill installation, under 60 minutes
- Assembled in the USA (Grand Forks, ND) — limited lifetime warranty
- Starting price: ~$1,999

UnderCover LUX — One-Piece Hard Cover | Paint-Matched
- Premium ABS plastic construction (won't crack or chip like fiberglass)
- Factory paint-matched to your truck's exact paint code — painted in-house by UnderCover
- Patented X-Effect Infrastructure keeps it rigid, won't twist or flex when open
- Full perimeter weatherproof seal, wrap-around edges over bed rails
- Center twist lock for security against unauthorized entry
- Aerodynamic design with subtle spoiler and rib styling
- Easy removal with 2 people when you need full bed access
- Assembled in Missouri — limited lifetime structural + paint warranty
- Great choice for customers who want a completely seamless, OEM look
- Starting price: ~$1,300+

UnderCover Ultra Flex (GEN 3) — Hard Folding
- Reinforced composite panels, aluminum frame, matte black finish
- Weather-tight perimeter seal, integrated locking, quick-release tailgate seal
- Folds in thirds for flexible bed access

WorkSport Nexus — Tri-Fold Hard Cover
- Aluminum construction, clean look, solid mid-range value

Cover types in plain English:
- Hard folding = great security, folds in sections for partial or full access (BAKFlip, Ultra Flex, Nexus)
- Retractable = premium, cleanest look, slides away completely into a canister (RetraxPRO)
- One-piece hard = most secure, paint-matched OEM look (UnderCover LUX)

3. TRUCK CAPS & CAMPER SHELLS
We carry A.R.E. truck caps — one of the most respected names in truck toppers. A.R.E. caps are built from high-quality fiberglass and are available in color-match to your truck's factory paint. Great for work trucks, overland builds, or anyone who wants secure, weather-tight enclosed cargo space. Various models available from utility to sport styles. Ask us about current availability and lead times.

4. STEPS FOR TRUCKS & SUVs
Traditional running boards, nerf bars, and premium electric power steps. As an authorized RealTruck dealer, we carry:

AMP Research PowerStep — Electric Power Steps | Premium (RealTruck brand)
- Automatically deploys when any door opens, retracts 3 seconds after doors close — fully automatic
- Die-cast aluminum construction with military-grade black PTFE coating
- 6-inch wide, cab-length slip-resistant step surface
- 600 lb load capacity (2x most competing steps)
- Integrated LED courtesy lights illuminate step and ground below
- Newer applications: Plug-N-Play via OBD II port (minimal wiring)
- When retracted, completely hidden under vehicle — looks completely stock
- 5-year limited warranty
- Professional installation required — 3–5 hours
- Starting price: ~$1,249

Westin Pro-e Electric Running Boards — Electric Power Steps
- Auto-deploy/retract when doors open and close, similar to AMP Research
- Clean, modern design that tucks away neatly when not in use
- Great alternative to AMP Research at a slightly lower price point
- Professional installation required — 3–5 hours
- Starting price: ~$1,724

Westin ProTraxx Steps — Traditional Running Boards
- 5-inch oval tube, heavy-duty aluminum or steel construction
- Available in polished, black powder coat, and stainless finishes
- No-drill on most applications, step pads included
- Great rugged look, solid value — installs in 60–90 minutes

Dee Zee Running Boards & Nerf Bars — Traditional Steps (Various Styles)
- Brite-Tread: Polished diamond-tread aluminum — bright, chrome-like shine
- Rough Step: Matte black aluminum — rugged, textured non-slip surface
- 6" oval nerf bars and 3" round tube nerf bars also available
- Excellent quality at a great value — budget-friendly to mid-range pricing

For plain English: Traditional steps = fixed boards always in position (install 60–90 min). Electric/power steps = deploy automatically, completely hidden when driving — premium OEM look (install 3–5 hrs).

5. CAR AUDIO & 12-VOLT
Full car audio and 12-volt electrical installation. Car audio is our roots — we professionally install everything we sell:
- Radios/head units (Apple CarPlay, Android Auto, Bluetooth, touchscreen)
- Speakers, subwoofers, amplifiers, custom wiring harnesses
- Backup cameras (install time: 1–2 hours)
- Brands carried: DD Audio (Digital Design), JVC, Kenwood, Pioneer, Alpine, and more
Install times: radio 1–2 hours, backup camera 1–2 hours

6. DASH CAMERAS
Our primary brand is Momento — a well-regarded dash cam brand known for reliability and image quality. We also help customers who bring their own cameras for professional installation. Options include:
- Front-facing cameras only
- Front + rear combo systems
- Interior cabin cameras
Professional installation included. Great for insurance protection, accident documentation, fleet management, and peace of mind.

7. PAINT PROTECTION FILM (PPF / Clear Bra)
LLumar PPF protects your paint from rock chips, road debris, scratches, and bugs. Virtually invisible, self-healing on premium grades. We can cover just the high-impact areas (hood, bumper, mirrors) or the full vehicle. More info: llumar.com/en/

BRING YOUR OWN PRODUCT:
We can also install products customers bring in themselves — radios, cameras, steps, etc. Call us to discuss your specific product and we'll let you know if it's something we can install.

WHAT WE DON'T OFFER:
- We are NOT a mechanical repair shop. We do not service engines, starters, alternators, brakes, transmissions, or any general auto repair/maintenance.
- We do NOT do suspension work — no lift kits, lowering kits, or suspension modifications at this time.
- If someone asks about mechanical work, politely let them know we're an accessories and installation shop and suggest they contact a local auto repair shop.

ORDER STATUS & INSTALL UPDATES:
If someone asks about their install status, order progress, when their vehicle will be ready, or anything about an active job — do NOT attempt to look up live status. Instead, reassure them and redirect:
"I want to make sure you're completely taken care of — for a real-time update on your vehicle, the fastest way is to give us a call directly at 405-799-6700. Our team will know exactly where things stand and will make sure you're happy with your visit."
Do not make up status information. The team has the most accurate picture of what's happening in the shop.

UPSET OR FRUSTRATED CUSTOMERS:
If a customer seems unhappy — with their install, a product, wait times, anything — lead with empathy and reassurance first. Never be defensive. Our priority is that they leave satisfied.
Example approach: "I'm really sorry to hear that — your satisfaction is important to us and we want to make this right. Can I get your name and the best number to reach you? I'll make sure our team follows up with you as soon as possible."
Once you have their name and phone, use sm_create_lead_estimate and log what they're unhappy about. The team will reach out directly. Let the customer know: "I've flagged this for our team and someone will be in touch shortly."

NEW CUSTOMER LEAD CAPTURE:
When a new customer wants to schedule or get info, capture their name, phone, and what they need using sm_create_lead_estimate, then let them know the team will follow up.

TONE: Friendly, conversational, knowledgeable. Plain language — no jargon unless they ask. Keep responses concise (2–5 sentences for most questions). Never invent prices — always say "starting around" or recommend calling for an exact quote. If unsure about a specific fitment or price, say "I'd recommend calling us or stopping by so we can check the exact fit and pricing for your vehicle."`;

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
    response = await anthropic.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 1024, system: CHAT_SYSTEM, messages, tools: CLAUDE_TOOLS });
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

  if (req.method === "POST" && (pathname === "/chat" || pathname === "/api/chat")) {
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

  if (req.method === "GET" && (pathname === "/widget" || pathname === "/api/widget")) {
    console.log("Widget request — cwd:", process.cwd());
    try {
      const html = readFileSync(join(process.cwd(), "src", "chatbot-widget.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch (e: any) {
      res.writeHead(500);
      res.end("Widget file not found: " + e.message);
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
  loadWorkflowStatuses();
});
