import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  // Resource routes (loader only, no default export): JSON for the polling
  // fallback and for `tcrs attach`'s reachability probe.
  route("api/generate", "routes/api.generate.ts"),
  route("api/cancel", "routes/api.cancel.ts"),
  route("api/status", "routes/api.status.ts"),
  route("api/files", "routes/api.files.ts"),
] satisfies RouteConfig;
