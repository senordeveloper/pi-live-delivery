export type ExecutionEvent = {
  id: string;
  tool: string;
  kind: 'command' | 'files' | 'search' | 'tool';
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  ts: number;
  detail?: string;
  files?: string[];
  order?: number;
  failure?: 'sandbox-unavailable';
};

export type AgentOutput = {
  beforeTs?: number;
  id: string;
  text: string;
  status: 'streaming' | 'completed' | 'interrupted';
  ts: number;
  order: number;
};

export type ExecutionTrace = { events: ExecutionEvent[]; output: AgentOutput[] };

export type HostEvent = {
  name: string;
  execution?: ExecutionEvent;
  userText?: string;
  assistantText?: string;
  pauseReason?: 'interrupt' | 'session_end';
};
