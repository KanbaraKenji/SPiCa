export function runFakeUv(o: {
  config: { log?: string; fail?: string; failText?: string; pythonUrl?: string };
  args: string[];
  env: Record<string, string | undefined>;
  input?: string;
}): { stdout: string; stderr: string; code: number };
