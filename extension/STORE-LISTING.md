# Chrome Web Store listing (ready to paste once the one-time $5 developer registration is done)

Developer dashboard: https://chrome.google.com/webstore/devconsole. Upload a zip of the `extension/` folder (manifest.json at the zip root, not inside a subfolder).

## Name
TxWhy for Solana explorers

## Summary (132 chars max)
Why did this Solana transaction fail? Plain-words cause, what to do, and whether it can be rebuilt, on every explorer page.

## Description
Every Solana explorer stops at "custom program error: 0x1771". This extension adds the missing paragraph.

Open any failed transaction on Solscan, Solana Explorer, SolanaFM or Orb and a small panel shows:
• the instruction that failed and the program that raised the error
• the cause in plain words (1,900+ published error codes across 40 programs, plus the runtime's own errors)
• what to do about it
• whether TxWhy can rebuild the transaction so it passes, and a link to the rebuilt version

It tells apart things explorers lump together. For example, Jupiter's slippage error and the Lighthouse wallet-guard error share the number 0x1771; the panel decodes the guard instruction itself and says exactly what it required.

Privacy: the extension reads only the transaction signature from the page URL and makes one request to txwhy.vercel.app with it. It reads nothing else on the page, stores nothing, has no account and no tracking. Source is public: https://github.com/SUNDRAM07/txwhy/tree/main/extension (MIT).

## Category
Developer Tools

## Language
English

## Privacy practices (dashboard form)
- Single purpose: explain why a Solana transaction failed on explorer pages.
- Permission justification, host permission txwhy.vercel.app: to request the explanation for the signature in the URL.
- Content scripts on explorer domains: to display the panel on transaction pages; no page content is read.
- Remote code: none. Data collection: none (the signature is public chain data and is not stored).

## Screenshots to upload (1280x800)
1. public/extension-explorer.png (Solana Explorer, Lighthouse guard explained)
2. A Solscan failed swap with "Rebuilt and verified" chip (take after loading unpacked)
3. The TxWhy transaction page the link opens

## Promo tile (440x280): the panel over a blurred explorer, text "Why did it fail?"
