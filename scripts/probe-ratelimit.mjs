// Checks that a client cannot dodge the per-IP limit by spoofing x-forwarded-for / x-real-ip.
// Sends more requests than the limit allows within a minute, each with a different forged
// client IP; if the platform does not overwrite the header, none would be refused.
// Run against production only when nothing else is testing, and never during a demo.
//   node scripts/probe-ratelimit.mjs            # https://txwhy.vercel.app
const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
const LIMIT = Number(process.env.LIMIT ?? 60);
const N = LIMIT + 15;
const body = JSON.stringify({ transaction: "" }); // a 400 from the decoder, cheap for the server, still counted by the limiter
let refused = 0, ok = 0, other = 0;
const started = Date.now();
for (let i = 0; i < N; i++) {
  const forged = `203.0.113.${(i % 250) + 1}`;
  const res = await fetch(`${BASE}/api/v1/repair`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-txwhy-client": "test", "x-forwarded-for": forged, "x-real-ip": forged },
    body,
  });
  if (res.status === 429) refused++;
  else if (res.status === 400) ok++;
  else other++;
}
console.log(`${N} requests with ${N} forged client IPs in ${((Date.now() - started) / 1000).toFixed(1)}s: ${ok} answered, ${refused} rate-limited, ${other} other`);
if (refused === 0) {
  console.log("FAIL: the limiter trusted the forged headers; a client can bypass the per-IP limit.");
  process.exit(1);
}
console.log("PASS: forged headers are ignored; the limit is enforced on the real client address.");
