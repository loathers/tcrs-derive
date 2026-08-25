import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // A single self-contained file, so the container needs no node_modules for the
  // CLI and systemd/docker can point straight at it.
  noExternal: [/.*/],
  banner: {
    // Bundling CJS deps into an ESM output leaves runtime require() calls that
    // esbuild cannot rewrite. This is the standard shim: define require in module
    // scope so those calls resolve instead of throwing "Dynamic require of ...".
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  sourcemap: true,
  clean: false,
  esbuildPlugins: [
    {
      // ink statically imports react-devtools-core from a branch it only takes when
      // the DEV env var is set. It is an optional peer we deliberately do not
      // install, so stub it rather than pulling ~10MB of devtools into the binary.
      // `external` cannot be used here: noExternal's catch-all takes precedence.
      name: "stub-react-devtools",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          // ink does `import devtools from "react-devtools-core"`, so the stub
          // needs a default export with the same shape.
          contents:
            "const noop = () => {};\n" +
            "export const connectToDevTools = noop;\n" +
            "export default { connectToDevTools: noop };\n",
          loader: "js",
        }));
      },
    },
  ],
});
