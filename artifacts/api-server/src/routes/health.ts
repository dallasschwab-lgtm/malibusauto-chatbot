import { HealthCheckResponse } from "@workspace/api-zod";
import type { Handler } from "../types.js";

export const healthHandler: Handler = (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
