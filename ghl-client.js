// Thin wrapper around the GoHighLevel (LeadConnector) REST API v2.
// Docs: https://marketplace.gohighlevel.com/docs/

// Overridable for local testing; production always uses the real API.
const BASE_URL = process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

function requireEnv(name) {
    const val = process.env[name];
    if (!val) {
          throw new Error(
                  `Missing required environment variable: ${name}. Set it in your Railway project's Variables tab.`
                );
    }
    return val;
}

async function ghlRequest(path, { method = "GET", body, query } = {}) {
    const token = requireEnv("GHL_PRIVATE_TOKEN");

  const url = new URL(BASE_URL + path);
    if (query) {
          for (const [k, v] of Object.entries(query)) {
                  if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
          }
    }

  const res = await fetch(url, {
        method,
        headers: {
                Authorization: `Bearer ${token}`,
                Version: API_VERSION,
                Accept: "application/json",
                ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
    let json;
    try {
          json = text ? JSON.parse(text) : {};
    } catch {
          json = { raw: text };
    }

  if (!res.ok) {
        const message =
                json?.message || json?.error || `GoHighLevel API error (HTTP ${res.status})`;
        const err = new Error(
                typeof message === "string" ? message : JSON.stringify(message)
              );
        err.status = res.status;
        err.body = json;
        throw err;
  }

  return json;
}

/** List every pipeline (and its stages) for the configured location. */
export async function listPipelines() {
    const locationId = requireEnv("GHL_LOCATION_ID");
    const data = await ghlRequest("/opportunities/pipelines", {
          query: { locationId },
    });
    return data.pipelines || [];
}

/** Create or update a contact by email/phone. Returns the contact object. */
export async function upsertContact(fields) {
    const locationId = requireEnv("GHL_LOCATION_ID");
    const data = await ghlRequest("/contacts/upsert", {
          method: "POST",
          body: { locationId, ...fields },
    });
    return data.contact || data;
}

/** Create an opportunity in a specific pipeline + stage for a contact. */
export async function createOpportunity(fields) {
    const locationId = requireEnv("GHL_LOCATION_ID");
    const data = await ghlRequest("/opportunities/", {
          method: "POST",
          body: { locationId, status: "open", ...fields },
    });
    return data.opportunity || data;
}
