export interface TraceNode {
  /** Human index like "3" or "3.1.2" */
  index: string;
  programId: string;
  programName: string;
  instructionName?: string;
  failed: boolean;
  depth: number;
  children: TraceNode[];
}

export interface DecodedError {
  title: string;
  code?: string;
  cause: string;
  fix: string;
}

export interface Trace {
  signature: string;
  slot: number;
  blockTime: number | null;
  success: boolean;
  feeLamports: number;
  failedOuterIndex: number | null;
  error: DecodedError | null;
  logs: string[];
  tree: TraceNode[];
}
