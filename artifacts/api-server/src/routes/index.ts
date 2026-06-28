import type { Handler, Router } from "../types.js";
import { healthHandler } from "./health.js";
import { fetchExampleHandler } from "./fetch-example.js";

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [
  { method: "GET", pattern: /^\/api\/healthz$/, handler: healthHandler },
  { method: "GET", pattern: /^\/api\/fetch-example$/, handler: fetchExampleHandler },
];

export const router: Router = (method, pathname) => {
  for (const route of routes) {
    if (route.method === method && route.pattern.test(pathname)) {
      return route.handler;
    }
  }
  return null;
};
