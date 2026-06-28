/**
 * Re-export node-fetch for use throughout the server.
 * Use `apiFetch` instead of importing node-fetch directly so all outbound
 * HTTP calls go through a single entry point.
 */
export { default as apiFetch } from "node-fetch";
export type { Response, RequestInit, HeadersInit } from "node-fetch";
