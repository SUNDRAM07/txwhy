# TxWhy for Solana explorers

A browser extension that answers the question every explorer page leaves open: **why did this transaction fail, and can it be fixed?**

Open any failed transaction on Solscan, Solana Explorer, SolanaFM or Orb. Where the explorer shows `custom program error: 0x1771`, the TxWhy panel shows the failing instruction, the program that raised it, the cause in plain words, what to do, and whether TxWhy can rebuild it. If a wallet safety guard (Lighthouse) tripped, it says exactly what the guard required.

![TxWhy panel on Solana Explorer](https://txwhy.vercel.app/extension-explorer.png)

## Install (Chrome, Brave, Edge, Arc)

Until it is on the Web Store, load it unpacked:

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/` folder.
4. Open any failed transaction on an explorer. The panel appears bottom right.

## What it does and does not do

- Reads only the transaction signature from the page URL.
- Makes one request, to `https://txwhy.vercel.app/api/v1/repair`, with that signature. The same free API anyone can call.
- Reads nothing else from the page, stores nothing, needs no account, no key, no permissions beyond talking to txwhy.vercel.app.
- Works on single-page explorers: when you navigate to another transaction, the panel updates.

Source: `content.js` (about 120 lines), `panel.css`, `manifest.json` (Manifest V3).
