require("@akashnetwork/env-loader");
const withBundleAnalyzer = require("@next/bundle-analyzer")({
  enabled: process.env.ANALYZE === "true"
});
const { version } = require("./package.json");
const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

// Optional subpath the app is served under (e.g. "/akash-console"), driven by a single
// env var. Normalized to a leading slash without a trailing one; blank = served at root.
// This same value also prefixes the public/ asset links in _document/PageHead and the
// next/image loader, so the reverse proxy doesn't need to bridge root-absolute assets.
const rawBasePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").trim().replace(/\/+$/, "");
const basePath = rawBasePath === "" ? "" : rawBasePath.startsWith("/") ? rawBasePath : `/${rawBasePath}`;

const transpilePackages = [
  "geist",
  "@akashnetwork/ui",
  "monaco-editor",
  "@nivo/core",
  "@nivo/line",
  "@nivo/pie",
  "@nivo/tooltip",
  "@nivo/colors",
  "@nivo/legends",
  "@nivo/scales",
  "@nivo/voronoi",
  "@nivo/axes",
  "@nivo/annotations",
  "d3-scale",
  "d3-scale-chromatic",
  "d3-interpolate",
  "d3-color",
  "d3-format",
  "d3-time",
  "d3-time-format",
  "d3-array",
  "d3-shape",
  "d3-path",
  "internmap"
];

/**
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: false,
  productionBrowserSourceMaps: true,
  ...(basePath ? { basePath } : {}),
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    // Re-export the normalized value so the client/SSR sees exactly what basePath uses.
    NEXT_PUBLIC_BASE_PATH: basePath
  },
  compiler: {
    styledComponents: true
  },
  images: {
    // Under a subpath the /_next/image optimizer resolves `url` without the prefix and
    // can't find local public/ images, so serve them unoptimized (static, basePath-aware).
    ...(basePath ? { unoptimized: true } : {}),
    remotePatterns: [
      { protocol: "https", hostname: "raw.githubusercontent.com" },
      { protocol: "https", hostname: "avatars.githubusercontent.com" }
    ]
  },
  output: "standalone",
  typescript: {
    tsconfigPath: "./tsconfig.build.json",
    ignoreBuildErrors: true
  },
  transpilePackages,
  i18n: {
    locales: ["en-US"],
    defaultLocale: "en-US"
  },
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 10
  },
  experimental: {
    // Required: @nivo/* dist is CJS but depends on ESM-only d3-* packages.
    // Without "loose", Next 16's production build refuses the CJS→ESM imports.
    esmExternals: "loose",
    optimizePackageImports: [
      "@interchain-ui/react",
      "@radix-ui/react-icons",
      "chain-registry",
      "iconoir-react",
      "react-icons",
      "tss-react"
    ]
  },
  webpack: (config, options) => {
    config.externals.push({
      "node:crypto": "crypto"
    });
    config.externals.push("pino-pretty");

    config.resolve.alias = {
      ...config.resolve.alias,
      "prettier/standalone": false,
      "prettier/plugins/yaml": false,
      prettier: false
    };

    if (!options.isServer) {
      config.plugins.push(
        new CopyPlugin({
          patterns: [
            {
              from: path.join(require.resolve("@akashnetwork/chain-sdk"), "..", "..", "sdl-schema.yaml"),
              to: "../public/sdl-schema.yaml"
            }
          ]
        })
      );
    }

    if (process.env.ANALYZE === "true") {
      config.optimization.moduleIds = "named";
      config.optimization.chunkIds = "named";
    }

    return config;
  },
  redirects: async () => {
    return [
      {
        source: "/deploy",
        destination: "/cloud-deploy",
        permanent: true
      }
    ];
  }
};

module.exports = withBundleAnalyzer(nextConfig);
