import express from "express";
import { readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { listPipelines, upsertContact, createOpportunity } from "./ghl-client.js";

// This server exposes a small, purpose-built set of GoHighLevel
// actions scoped to the Iventora vendor pipeline: list pipelines,
// upsert a contact, create an opportunity, and a combined helper
// that does both in one call. See README.md for setup and deploy.
//
// SECURITY NOTE: this endpoint has no authentication. Anyone with
// the URL can call these tools against your GHL location. Treat the
// deployed URL like a secret, same as your GHL webhook URL - do not
// post it publicly. See README.md for optional hardening options.

function buildServer() {
    const server = new McpServer(
      { name: "iventora-ghl-vendor-pipeline", version: "1.0.0" },
      { capabilities: { tools: {} } }
        );

  server.registerTool(
        "ghl_list_pipelines",
    {
            title: "List GHL Pipelines",
            description:
                      "List every pipeline and its stages, with IDs, in the configured GoHighLevel location. Use this first to find the pipelineId and pipelineStageId you want vendor applications to land in.",
            inputSchema: {},
    },
        async () => {
                const pipelines = await listPipelines();
                const summary = pipelines.map((p) => ({
                          id: p.id,
                          name: p.name,
                          stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })),
                }));
                return {
                          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
                };
        }
      );

  server.registerTool(
        "ghl_upsert_contact",
    {
            title: "Create or Update GHL Contact",
            description:
                      "Create a new contact in GoHighLevel, or update a matching one, matched by email or phone. Requires email or phone.",
            inputSchema: {
                      firstName: z.string().optional(),
                      lastName: z.string().optional(),
                      name: z.string().optional().describe("Full name, if not split into first/last"),
                      email: z.string().email().optional(),
                      phone: z.string().optional(),
                      companyName: z.string().optional(),
                      address1: z.string().optional(),
                      city: z.string().optional(),
                      state: z.string().optional(),
                      postalCode: z.string().optional(),
                      website: z.string().optional(),
                      tags: z.array(z.string()).optional(),
                      source: z.string().optional().describe("e.g. Iventora Vendor Intake Form"),
            },
    },
        async (args) => {
                if (!args.email && !args.phone) {
                          throw new Error("Provide at least an email or phone to identify the contact.");
                }
                const contact = await upsertContact(args);
                return {
                          content: [
                            {
                                          type: "text",
                                          text: "Contact upserted. id=" + (contact.id || "unknown") + "\n" + JSON.stringify(contact, null, 2),
                            },
                                    ],
                };
        }
      );

  server.registerTool(
        "ghl_create_opportunity",
    {
            title: "Create GHL Opportunity",
            description:
                      "Create an opportunity for an existing contact in a specific pipeline and stage. Use ghl_list_pipelines to find pipelineId and pipelineStageId first.",
            inputSchema: {
                      contactId: z.string().describe("Contact ID returned by ghl_upsert_contact"),
                      pipelineId: z.string(),
                      pipelineStageId: z.string().optional(),
                      name: z.string().describe("Opportunity name, e.g. Acme Catering - Vendor Application"),
                      monetaryValue: z.number().optional(),
                      status: z.enum(["open", "won", "lost", "abandoned"]).optional(),
            },
    },
        async (args) => {
                const opp = await createOpportunity(args);
                return {
                          content: [
                            {
                                          type: "text",
                                          text: "Opportunity created. id=" + (opp.id || "unknown") + "\n" + JSON.stringify(opp, null, 2),
                            },
                                    ],
                };
        }
      );

  server.registerTool(
        "ghl_submit_vendor_application",
    {
            title: "Submit Vendor Application to GHL",
            description:
                      "Convenience action: upserts the vendor as a contact, then creates an opportunity for them in the given pipeline and stage. Equivalent to calling ghl_upsert_contact then ghl_create_opportunity.",
            inputSchema: {
                      businessName: z.string(),
                      contactName: z.string().optional(),
                      email: z.string().email().optional(),
                      phone: z.string().optional(),
                      website: z.string().optional(),
                      address1: z.string().optional(),
                      city: z.string().optional(),
                      state: z.string().optional(),
                      postalCode: z.string().optional(),
                      categories: z.array(z.string()).optional(),
              plan: z.string().optional(),
                      pipelineId: z.string(),
                      pipelineStageId: z.string().optional(),
                      monetaryValue: z.number().optional(),
            },
    },
        async (args) => {
                if (!args.email && !args.phone) {
                          throw new Error("Provide at least an email or phone to identify the vendor.");
                }
                const nameParts = (args.contactName || args.businessName).split(" ");
                const firstName = nameParts[0];
                const rest = nameParts.slice(1);
                const contact = await upsertContact({
                          firstName,
                          lastName: rest.join(" ") || undefined,
                          email: args.email,
                          phone: args.phone,
                          companyName: args.businessName,
                          website: args.website,
                          address1: args.address1,
                          city: args.city,
                          state: args.state,
                          postalCode: args.postalCode,
                          tags: ["vendor-application"].concat(args.categories || []),
                          source: "Iventora Vendor Intake Form",
                });

          const opp = await createOpportunity({
                    contactId: contact.id,
                    pipelineId: args.pipelineId,
                    pipelineStageId: args.pipelineStageId,
                    name: args.businessName + " - Vendor Application",
                    monetaryValue: args.monetaryValue,
          });

          return {
                    content: [
                      {
                                    type: "text",
                                    text: JSON.stringify(
                                      { contactId: contact.id, opportunityId: opp.id, plan: args.plan || null },
                                                    null,
                                                    2
                                                  ),
                      },
                              ],
          };
        }
      );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

app.get("/", (req, res) => {
    res.json({ ok: true, service: "iventora-ghl-mcp-server", mcpEndpoint: "/mcp" });
});

app.get("/apply", (req, res) => {
    res.set("Content-Type", "text/html");
    res.send(readFileSync(new URL("./vendor-form-ascii-full.html", import.meta.url), "utf8"));
});

app.post("/mcp", async (req, res) => {
    try {
          const server = buildServer();
          const transport = new StreamableHTTPServerTransport({
                  sessionIdGenerator: undefined,
          });
          res.on("close", () => {
                  transport.close();
                  server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
    } catch (err) {
          console.error("MCP request error:", err);
          if (!res.headersSent) {
                  res.status(500).json({
                            jsonrpc: "2.0",
                            error: { code: -32603, message: err.message || "Internal server error" },
                            id: null,
                  });
          }
    }
});

app.get("/mcp", (req, res) => {
    res.status(405).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed. POST only." },
          id: null,
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Iventora GHL MCP server listening on port " + PORT);
    console.log("MCP endpoint: POST /mcp");
});
