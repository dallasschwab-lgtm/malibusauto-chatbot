import type http from "node:http";

export interface RequestContext {
  url: URL;
  method: string;
  body: unknown;
}

export type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
) => void | Promise<void>;

export type Router = (method: string, pathname: string) => Handler | null;
