import { Vault, normalizePath } from 'obsidian';
import { MengramClient } from './mengram-client';
import { MengramSettings } from './settings';

export interface PullResult {
    written: number;
    unchanged: number;
    removed: number;
}

/** Roots the server may serialise under, rewritten to the user's folder on the
 *  way in so someone who wants their memory in `Notes/Brain` gets it there.
 *
 *  Two of them, because the format was published as memfmt and the root became
 *  `memory/`; `Mengram/` is what every export before that used. Accepting both
 *  means a plugin update and a server deploy do not have to land in the same
 *  minute — whichever arrives first, files still land where the user asked. */
const SERVER_ROOTS = ['memory/', 'Mengram/'];

/**
 * Brings memory into the vault as files.
 *
 * The pull folder is generated: memory is the source of truth for it, and
 * anything edited inside is replaced on the next pull. That rule is what keeps
 * this simple — no merge engine, no conflict prompts. Editing happens in your
 * own notes, which sync the other way.
 *
 * Nothing outside the pull folder is ever touched.
 */
export class PullEngine {
    private vault: Vault;
    private settings: MengramSettings;
    private client: MengramClient | null = null;

    constructor(vault: Vault, settings: MengramSettings) {
        this.vault = vault;
        this.settings = settings;
    }

    setClient(client: MengramClient | null): void {
        this.client = client;
    }

    updateSettings(settings: MengramSettings): void {
        this.settings = settings;
    }

    private get root(): string {
        return normalizePath((this.settings.pullFolder || 'Mengram').replace(/^\/+|\/+$/g, ''));
    }

    private localPath(serverPath: string): string {
        let tail = serverPath;
        for (const root of SERVER_ROOTS) {
            if (serverPath.startsWith(root)) {
                tail = serverPath.slice(root.length);
                break;
            }
        }
        return normalizePath(`${this.root}/${tail}`);
    }

    /** Create every folder on the way to a file. The vault API will not do it
     *  for us, and a missing parent is the usual reason a write fails. */
    private async ensureParent(path: string): Promise<void> {
        const parts = path.split('/');
        parts.pop();
        let sofar = '';
        for (const part of parts) {
            sofar = sofar ? `${sofar}/${part}` : part;
            if (!(await this.vault.adapter.exists(sofar))) {
                await this.vault.adapter.mkdir(sofar);
            }
        }
    }

    /** Files currently under the pull folder, so ones the memory no longer has
     *  can be cleared out rather than left behind as ghosts. */
    private async existingFiles(): Promise<string[]> {
        const found: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            if (!(await this.vault.adapter.exists(dir))) return;
            const listing = await this.vault.adapter.list(dir);
            for (const file of listing.files) {
                if (file.endsWith('.md')) found.push(file);
            }
            for (const sub of listing.folders) await walk(sub);
        };
        await walk(this.root);
        return found;
    }

    async pull(onProgress?: (line: string) => void): Promise<PullResult> {
        if (!this.client) throw new Error('no API key configured');

        onProgress?.('Mengram: fetching memory…');
        const tree = await this.client.exportFiles({ userId: this.settings.userId });

        const wanted = new Map<string, string>();
        for (const [serverPath, text] of Object.entries(tree)) {
            wanted.set(this.localPath(serverPath), text);
        }

        const before = await this.existingFiles();
        let written = 0;
        let unchanged = 0;

        let done = 0;
        for (const [path, text] of wanted) {
            // Skip writes that would change nothing: Obsidian reacts to every
            // modification, and rewriting an untouched vault would churn the
            // graph and any sync the user runs on top.
            const exists = await this.vault.adapter.exists(path);
            if (exists && (await this.vault.adapter.read(path)) === text) {
                unchanged++;
            } else {
                await this.ensureParent(path);
                await this.vault.adapter.write(path, text);
                written++;
            }
            done++;
            if (done % 10 === 0) onProgress?.(`Mengram: pulling ${done} of ${wanted.size}`);
        }

        // Whatever the memory no longer holds should not linger in the folder
        // it owns. Confined to the pull folder, and only ever Markdown.
        let removed = 0;
        for (const path of before) {
            if (!wanted.has(path)) {
                await this.vault.adapter.remove(path);
                removed++;
            }
        }

        return { written, unchanged, removed };
    }
}
