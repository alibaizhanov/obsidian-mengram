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
    knowledge: any[];
    relations: any[];
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
    result?: any;
    error?: string;
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

    private async _request(method: string, path: string, body?: any, params?: Record<string, string>): Promise<any> {
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
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeout);
            try {
                const res = await fetch(url, {
                    method,
                    headers,
                    body: body ? JSON.stringify(body) : undefined,
                    signal: controller.signal,
                });
                const data = await res.json();
                if (!res.ok) {
                    if ([429, 502, 503, 504].includes(res.status) && attempt < 2) {
                        lastErr = new MengramError(data.detail || `HTTP ${res.status}`, res.status);
                        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                        continue;
                    }
                    throw new MengramError(data.detail || `HTTP ${res.status}`, res.status);
                }
                return data;
            } catch (err: any) {
                if (err instanceof MengramError) {
                    if ([429, 502, 503, 504].includes(err.statusCode) && attempt < 2) {
                        lastErr = err;
                        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                        continue;
                    }
                    throw err;
                }
                if (err.name === 'AbortError') {
                    throw new MengramError(`Request timeout after ${this.timeout}ms`, 408);
                }
                if (attempt < 2) {
                    lastErr = err;
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                    continue;
                }
                throw new MengramError(err.message, 0);
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastErr || new MengramError('Request failed after 3 attempts', 0);
    }

    async addText(text: string, options: { userId?: string } = {}): Promise<AddTextResult> {
        return this._request('POST', '/v1/add_text', {
            text,
            user_id: options.userId || 'default',
        });
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
        return this._request('GET', '/v1/stats', undefined, params);
    }

    async waitForJob(jobId: string, options: { pollInterval?: number; maxWait?: number } = {}): Promise<JobResult> {
        const interval = options.pollInterval || 1500;
        const maxWait = options.maxWait || 60000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            const job: JobResult = await this._request('GET', `/v1/jobs/${jobId}`);
            if (job.status === 'completed' || job.status === 'failed') {
                return job;
            }
            await new Promise(r => setTimeout(r, interval));
        }
        throw new MengramError('Job timed out', 408);
    }
}
