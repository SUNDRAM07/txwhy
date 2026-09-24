// Bundles the SDK with esbuild and emits type declarations with tsc.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";

rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });
const common = { entryPoints: ["src/index.ts", "src/verify.ts", "src/kit.ts"], bundle: true, platform: "neutral", target: "es2020", external: ["@solana/web3.js", "@solana/kit"], outdir: "dist", logLevel: "info" };
await build({ ...common, format: "esm" });
await build({ ...common, format: "cjs", outExtension: { ".js": ".cjs" } });
execSync("npx tsc -p tsconfig.json", { stdio: "inherit" });
copyFileSync(new URL("../LICENSE", import.meta.url), new URL("./LICENSE", import.meta.url));
