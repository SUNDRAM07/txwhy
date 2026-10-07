"use client";

import { useEffect, useState } from "react";

export interface IndexSummary {
  updatedAt: string;
  transactionsSeen: number;
  failed: number;
  failureRate: number;
  byProgram: { program: string; seen: number; failed: number; failureRate: number }[];
  repair?: {
    attempted: number;
    verdicts: Record<string, number>;
    segments?: { rebuilt: number; rebuiltShareOfPeople: number; people: number };
  };
}

let cache: IndexSummary | null = null;
let inflight: Promise<IndexSummary | null> | null = null;

/** The public failure index, fetched once per page and shared by every widget that shows it. */
export function loadIndex(): Promise<IndexSummary | null> {
  if (cache) return Promise.resolve(cache);
  inflight ??= fetch("/api/v1/index", { headers: { "x-txwhy-client": "web" } })
    .then((res) => (res.ok ? (res.json() as Promise<IndexSummary>) : null))
    .then((json) => {
      if (json?.transactionsSeen) cache = json;
      return cache;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useIndex(): IndexSummary | null {
  const [index, setIndex] = useState<IndexSummary | null>(cache);
  useEffect(() => {
    let alive = true;
    if (!cache) {
      void loadIndex().then((value) => {
        if (alive && value) setIndex(value);
      });
    }
    return () => {
      alive = false;
    };
  }, []);
  return index;
}
