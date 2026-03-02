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

    constructor(apiKey: string, options: { baseUrl?: string; timeout?: number } = {}) {
        if (!apiKey) throw new Error('API key is required');
        this.apiKey = apiKey;
        this.baseUrl = (options.baseUrl || 'https://mengram.io').replace(/\/$/, '');
        this.timeout = options.timeout || 30000;
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
                const data = response.json as ApiResponse;
                if (response.status >= 400) {
                    if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
                        lastErr = new MengramError(data.detail || `HTTP ${response.status}`, response.status);
                        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
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
                        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                        continue;
                    }
                    throw error;
                }
                if (attempt < 2) {
                    lastErr = error;
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
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
            await new Promise(r => setTimeout(r, interval));
        }
        throw new MengramError('Job timed out', 408);
    }
}
