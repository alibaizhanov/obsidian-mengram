import { requestUrl } from 'obsidian';

export class MengramError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
        super(message);
        this.name = 'MengramError';
        this.statusCode = statusCode;
    }
}

export interface SearchResult {
    entity: string;
    type: string;
    score: number;
    facts: string[];
    knowledge: Record<string, unknown>[];
    relations: Record<string, unknown>[];
}

export interface AddTextResult {
    status: string;
    message?: string;
    job_id?: string;
}

export interface StatsResult {
    entities: number;
    facts: number;
    knowledge: number;
    relations: number;
    embeddings: number;
    by_type: Record<string, number>;
}

export interface JobResult {
    status: 'pending' | 'processing' | 'completed' | 'failed';
    result?: Record<string, unknown>;
    error?: string;
}

interface ApiResponse {
    results?: SearchResult[];
    detail?: string;
    [key: string]: unknown;
}

export class MengramClient {
    private apiKey: string;
    private baseUrl: string;
    private timeout: number;

    /** Requests per minute this key is allowed, as last reported by the server
     *  (X-RateLimit-Limit). Null until a response has been seen. Bulk callers
     *  read this to pace themselves instead of guessing. */
    rateLimitPerMin: number | null = null;

    /** Longest a 429 will be honoured for. The server currently asks for 60s;
     *  the cap stops a misconfigured Retry-After from hanging a vault sync. */
    private static readonly MAX_RETRY_AFTER_MS = 90_000;

    constructor(apiKey: string, options: { baseUrl?: string; timeout?: number } = {}) {
        if (!apiKey) throw new Error('API key is required');
        this.apiKey = apiKey;
        this.baseUrl = (options.baseUrl || 'https://mengram.io').replace(/\/$/, '');
        this.timeout = options.timeout || 30000;
    }

    /** Narrows whatever the server sent into something safe to read.
     *
     *  requestUrl hands back `any`, and asserting `as ApiResponse` only told
     *  the compiler to stop asking — a non-object body (an HTML error page, a
     *  proxy's plain-text 502) would then throw on the first property access,
     *  surfacing as an unrelated TypeError instead of the real failure. */
    private static asResponse(body: unknown): ApiResponse {
        if (body && typeof body === 'object' && !Array.isArray(body)) {
            return body as ApiResponse;
        }
        return {};
    }

    /** Header lookup that does not care about casing — Obsidian's requestUrl
     *  lowercases them, other runtimes do not. */
    private static header(headers: Record<string, string> | undefined, name: string): string | undefined {
        if (!headers) return undefined;
        const wanted = name.toLowerCase();
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === wanted) return headers[key];
        }
        return undefined;
    }

    /** How long to wait after a 429, from Retry-After when the server sends it.
     *  The old backoff of one second could never clear a per-minute limit: all
     *  three attempts landed inside the same blocked window. */
    private static retryAfterMs(headers: Record<string, string> | undefined): number {
        const raw = MengramClient.header(headers, 'retry-after');
        const seconds = raw ? Number(raw) : NaN;
        const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
        return Math.min(ms, MengramClient.MAX_RETRY_AFTER_MS);
    }

    private async _request(method: string, path: string, body?: Record<string, unknown>, params?: Record<string, string>): Promise<ApiResponse> {
        let url = `${this.baseUrl}${path}`;
        if (params) {
            const qs = Object.entries(params)
                .filter(([, v]) => v !== undefined && v !== null)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join('&');
            if (qs) url += `?${qs}`;
        }

        const headers: Record<string, string> = {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
        };

        let lastErr: Error | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await requestUrl({
                    url,
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    throw: false,
                });
                const limit = Number(MengramClient.header(response.headers, 'x-ratelimit-limit'));
                if (Number.isFinite(limit) && limit > 0) this.rateLimitPerMin = limit;

                const data = MengramClient.asResponse(response.json);
                if (response.status >= 400) {
                    if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
                        lastErr = new MengramError(data.detail || `HTTP ${response.status}`, response.status);
                        const wait = response.status === 429
                            ? MengramClient.retryAfterMs(response.headers)
                            : 1000 * (attempt + 1);
                        await new Promise(r => window.setTimeout(r, wait));
                        continue;
                    }
                    throw new MengramError(data.detail || `HTTP ${response.status}`, response.status);
                }
                return data;
            } catch (err: unknown) {
                const error = err instanceof Error ? err : new Error(String(err));
                if (error instanceof MengramError) {
                    if ([429, 502, 503, 504].includes(error.statusCode) && attempt < 2) {
                        lastErr = error;
                        await new Promise(r => window.setTimeout(r, 1000 * (attempt + 1)));
                        continue;
                    }
                    throw error;
                }
                if (attempt < 2) {
                    lastErr = error;
                    await new Promise(r => window.setTimeout(r, 1000 * (attempt + 1)));
                    continue;
                }
                throw new MengramError(error.message, 0);
            }
        }
        throw lastErr || new MengramError('Request failed after 3 attempts', 0);
    }

    async addText(text: string, options: { userId?: string } = {}): Promise<AddTextResult> {
        const data = await this._request('POST', '/v1/add_text', {
            text,
            user_id: options.userId || 'default',
        });
        return data as unknown as AddTextResult;
    }

    async search(query: string, options: { userId?: string; limit?: number } = {}): Promise<SearchResult[]> {
        const data = await this._request('POST', '/v1/search', {
            query,
            user_id: options.userId || 'default',
            limit: options.limit || 10,
        });
        return data.results || [];
    }

    /** The memory as ready-to-write files, keyed by path.
     *
     *  The server serialises, so what lands in a vault is byte-identical to
     *  the zip `mengram export` produces. Building the Markdown here instead
     *  would be a second implementation waiting to disagree with the first. */
    async exportFiles(options: { userId?: string } = {}): Promise<Record<string, string>> {
        const params: Record<string, string> = { format: 'files' };
        if (options.userId && options.userId !== 'default') {
            params.sub_user_id = options.userId;
        }
        const data = await this._request('GET', '/v1/export', undefined, params);
        return (data.files as Record<string, string>) || {};
    }

    async stats(options: { userId?: string } = {}): Promise<StatsResult> {
        const params: Record<string, string> = {};
        if (options.userId && options.userId !== 'default') {
            params.sub_user_id = options.userId;
        }
        const data = await this._request('GET', '/v1/stats', undefined, params);
        return data as unknown as StatsResult;
    }

    async waitForJob(jobId: string, options: { pollInterval?: number; maxWait?: number } = {}): Promise<JobResult> {
        const interval = options.pollInterval || 1500;
        const maxWait = options.maxWait || 60000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            const job = await this._request('GET', `/v1/jobs/${jobId}`) as unknown as JobResult;
            if (job.status === 'completed' || job.status === 'failed') {
                return job;
            }
            await new Promise(r => window.setTimeout(r, interval));
        }
        throw new MengramError('Job timed out', 408);
    }
}
