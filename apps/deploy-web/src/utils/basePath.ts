import { browserEnvConfig } from "@src/config/browser-env.config";

/** Subpath the app is served under (e.g. "/akash-console"), or "" when served at the root. */
export const basePath = browserEnvConfig.NEXT_PUBLIC_BASE_PATH;

/**
 * Prefixes an absolute public/ asset path with the configured basePath.
 *
 * Next.js only auto-prefixes next/link, next/image and the _next chunks with basePath;
 * manual <link>/<meta> asset URLs in the document head (favicon, manifest, …) resolve
 * against the origin root unless prefixed explicitly. Without this they 404 under a
 * subpath deployment (or have to be bridged in the reverse proxy).
 */
export const withBasePath = (assetPath: string): string => {
  const normalized = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
  return `${basePath}${normalized}`;
};
