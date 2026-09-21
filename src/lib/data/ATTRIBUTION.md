# Data attribution

`program-errors.json` contains error tables (code, name, message) for 37 Solana programs.
It was extracted from the **solana-idls** dataset by tenequm (https://github.com/tenequm/solana-idls), version 1.2.1, MIT License.
Only the `errors` arrays of each IDL are included, keyed by program id.

Regenerate with `node scripts/build-error-db.mjs` after installing `solana-idls` as a dev dependency.
