import { apiFetch } from "../lib/fetch.js";
import type { Handler } from "../types.js";

/**
 * GET /api/fetch-example
 *
 * Demonstrates node-fetch by calling a public REST API and returning the result.
 */
export const fetchExampleHandler: Handler = async (_req, res) => {
  const response = await apiFetch("https://jsonplaceholder.typicode.com/todos/1");
  const data = await response.json();

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    message: "Fetched from jsonplaceholder.typicode.com via node-fetch",
    data,
  }));
};
