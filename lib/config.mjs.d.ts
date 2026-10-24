export function loadEnvLocal(root?: string): void;

export function rpcUrlFromEnv(): string | undefined;

export function resolveRpcUrl(explicitUrl?: string): string;

export function maskRpcUrl(rpcUrl: string): string;
