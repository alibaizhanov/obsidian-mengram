import { TFile, Vault, Notice } from 'obsidian';
import { MengramClient } from './mengram-client';
import type { MengramSettings } from './settings';

export interface SyncState {
    fileHashes: Record<string, string>;
}

export class SyncEngine {
    private vault: Vault;
    private client: MengramClient | null = null;
    private settings: MengramSettings;
    private state: SyncState;
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private queue: TFile[] = [];
    private processing = false;
    private statusCallback: (status: string) => void;
    private saveState: () => Promise<void>;

    constructor(
        vault: Vault,
        settings: MengramSettings,
        state: SyncState,
        statusCallback: (status: string) => void,
        saveState: () => Promise<void>,
    ) {
        this.vault = vault;
        this.settings = settings;
        this.state = state;
        this.statusCallback = statusCallback;
        this.saveState = saveState;
        this.reinitClient();
    }

    reinitClient(): void {
        if (this.settings.apiKey) {
            this.client = new MengramClient(this.settings.apiKey, {
                baseUrl: this.settings.baseUrl,
            });
        } else {
            this.client = null;
        }
    }

    updateSettings(settings: MengramSettings): void {
        this.settings = settings;
    }

    shouldSync(file: TFile): boolean {
        if (file.extension !== 'md') return false;

        const path = file.path;

        // Exclude Obsidian config folder (uses configDir, not hardcoded)
        const configDir = this.vault.configDir;
        if (path.startsWith(configDir + '/')) return false;

        const excluded = this.parseFolderList(this.settings.excludedFolders);
        for (const folder of excluded) {
            if (path.startsWith(folder + '/') || path === folder) return false;
        }

        const included = this.parseFolderList(this.settings.syncFolders);
        if (included.length > 0) {
            return included.some(folder => path.startsWith(folder + '/'));
        }

        return true;
    }

    private parseFolderList(csv: string): string[] {
        return csv.split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }

    private hashContent(content: string): string {
        let hash = 5381;
        for (let i = 0; i < content.length; i++) {
            hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0xffffffff;
        }
        return hash.toString(36);
    }

    private hasChanged(filePath: string, content: string): boolean {
        const newHash = this.hashContent(content);
        const oldHash = this.state.fileHashes[filePath];
        if (oldHash === newHash) return false;
        this.state.fileHashes[filePath] = newHash;
        return true;
    }

    onFileModified(file: TFile): void {
        if (!this.settings.autoSync) return;
        if (!this.client) return;
        if (!this.shouldSync(file)) return;

        const existing = this.debounceTimers.get(file.path);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this.debounceTimers.delete(file.path);
            this.enqueue(file);
        }, this.settings.debounceMs);

        this.debounceTimers.set(file.path, timer);
    }

    private enqueue(file: TFile): void {
        if (!this.queue.some(f => f.path === file.path)) {
            this.queue.push(file);
        }
        void this.processQueue();
    }

    private async processQueue(): Promise<void> {
        if (this.processing) return;
        if (this.queue.length === 0) return;
        if (!this.client) return;

        this.processing = true;

        while (this.queue.length > 0) {
            const file = this.queue.shift()!;
            await this.syncFile(file);
        }

        this.processing = false;
        this.statusCallback('idle');
    }

    async syncFile(file: TFile): Promise<boolean> {
        if (!this.client) {
            new Notice('Mengram: no API key configured');
            return false;
        }

        try {
            const content = await this.vault.cachedRead(file);

            if (!content || content.trim().length === 0) return false;

            if (!this.hasChanged(file.path, content)) return false;

            this.statusCallback('syncing');

            const textToSync = `Note: ${file.basename}\n\n${content}`;

            await this.client.addText(textToSync, {
                userId: this.settings.userId,
            });

            await this.saveState();
            this.statusCallback('synced');

            return true;
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error(`Mengram: failed to sync ${file.path}:`, error);
            delete this.state.fileHashes[file.path];
            this.statusCallback('error');
            new Notice(`Mengram: sync failed for ${file.basename}: ${error.message}`);
            return false;
        }
    }

    async syncVault(): Promise<{ synced: number; skipped: number; errors: number }> {
        if (!this.client) {
            new Notice('Mengram: no API key configured');
            return { synced: 0, skipped: 0, errors: 0 };
        }

        const files = this.vault.getMarkdownFiles().filter(f => this.shouldSync(f));
        const total = files.length;
        let synced = 0;
        let skipped = 0;
        let errors = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            this.statusCallback(`syncing ${i + 1}/${total}`);

            try {
                const content = await this.vault.cachedRead(file);
                if (!content || content.trim().length === 0) {
                    skipped++;
                    continue;
                }

                if (!this.hasChanged(file.path, content)) {
                    skipped++;
                    continue;
                }

                const textToSync = `Note: ${file.basename}\n\n${content}`;
                await this.client.addText(textToSync, {
                    userId: this.settings.userId,
                });
                synced++;

                if (synced % 10 === 0) {
                    await this.saveState();
                }

                await new Promise(r => setTimeout(r, 200));
            } catch (err: unknown) {
                const error = err instanceof Error ? err : new Error(String(err));
                console.error(`Mengram: failed to sync ${file.path}:`, error);
                delete this.state.fileHashes[file.path];
                errors++;
            }
        }

        await this.saveState();
        this.statusCallback('idle');
        return { synced, skipped, errors };
    }

    destroy(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.queue = [];
    }
}
