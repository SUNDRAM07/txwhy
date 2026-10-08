// Bundles the SDK with esbuild and emits type declarations with tsc.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";

rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });
// The wallet entry imports the main entry instead of bundling its own copy, so TxWhyError and the
// repair loop are the same objects whichever entry point a dApp imports (instanceof keeps working).
const shareIndex = (ext) => ({
  name: "share-index",
  setup(b) {
    b.onResolve({ filter: /^\.\/index$/ }, (args) => (args.importer.endsWith("wallet.ts") ? { path: `./index${ext}`, external: true } : undefined));
  },
});
const common = { entryPoints: ["src/index.ts", "src/verify.ts", "src/kit.ts", "src/wallet.ts"], bundle: true, platform: "neutral", target: "es2020", external: ["@solana/web3.js", "@solana/kit"], outdir: "dist", logLevel: "info" };
await build({ ...common, format: "esm", plugins: [shareIndex(".js")] });
await build({ ...common, format: "cjs", outExtension: { ".js": ".cjs" }, plugins: [shareIndex(".cjs")] });
execSync("npx tsc -p tsconfig.json", { stdio: "inherit" });
copyFileSync(new URL("../LICENSE", import.meta.url), new URL("./LICENSE", import.meta.url));
