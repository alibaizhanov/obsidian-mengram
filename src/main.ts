import { Plugin, TFile, Notice } from 'obsidian';
import { MengramClient } from './mengram-client';
import { MengramSettings, DEFAULT_SETTINGS, MengramSettingTab } from './settings';
import { SyncEngine, SyncState } from './sync';
import { PullEngine } from './pull';
import { MengramSearchModal } from './search-modal';

interface MengramPluginData {
    settings: MengramSettings;
    syncState: SyncState;
}

export default class MengramPlugin extends Plugin {
    settings: MengramSettings = DEFAULT_SETTINGS;
    private syncEngine!: SyncEngine;
    private pullEngine!: PullEngine;
    private pullTimer: number | null = null;
    private statusBarEl!: HTMLElement;
    private client: MengramClient | null = null;
    private syncState: SyncState = { fileHashes: {} };

    async onload(): Promise<void> {
        const data = await this.loadData() as MengramPluginData | null;
        if (data) {
            this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
            this.syncState = data.syncState || { fileHashes: {} };
        }

        this.reinitClient();

        this.statusBarEl = this.addStatusBarItem();
        this.updateStatus('idle');

        this.syncEngine = new SyncEngine(
            this.app.vault,
            this.settings,
            this.syncState,
            (status) => this.updateStatus(status),
            () => this.savePluginData(),
        );

        this.pullEngine = new PullEngine(this.app.vault, this.settings);
        this.pullEngine.setClient(this.client);
        this.schedulePull();

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) {
                    this.syncEngine.onFileModified(file);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) {
                    delete this.syncState.fileHashes[file.path];
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile && this.syncState.fileHashes[oldPath]) {
                    this.syncState.fileHashes[file.path] = this.syncState.fileHashes[oldPath];
                    delete this.syncState.fileHashes[oldPath];
                }
            })
        );

        this.addCommand({
            id: 'search-memories',
            name: 'Search memories',
            callback: () => {
                if (!this.client) {
                    new Notice('Mengram: please configure your API key in settings');
                    return;
                }
                new MengramSearchModal(
                    this.app,
                    this.client,
                    this.settings.userId,
                ).open();
            },
        });

        this.addCommand({
            id: 'sync-current-file',
            name: 'Sync current file',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'md') {
                    if (!checking) {
                        void this.syncCurrentFile(file);
                    }
                    return true;
                }
                return false;
            },
        });

        this.addCommand({
            id: 'sync-vault',
            name: 'Sync entire vault',
            callback: () => void this.syncVault(),
        });

        this.addCommand({
            id: 'pull-memory',
            name: 'Pull memory into vault',
            callback: () => void this.pullMemory(),
        });

        this.addCommand({
            id: 'show-stats',
            name: 'Show memory stats',
            callback: () => void this.showStats(),
        });

        this.addSettingTab(new MengramSettingTab(this.app, this));
    }

    onunload(): void {
        this.syncEngine?.destroy();
        if (this.pullTimer !== null) window.clearInterval(this.pullTimer);
    }

    reinitClient(): void {
        if (this.settings.apiKey) {
            this.client = new MengramClient(this.settings.apiKey, {
                baseUrl: this.settings.baseUrl,
            });
        } else {
            this.client = null;
        }
        this.syncEngine?.reinitClient();
        this.pullEngine?.setClient(this.client);
    }

    async saveSettings(): Promise<void> {
        this.syncEngine?.updateSettings(this.settings);
        this.pullEngine?.updateSettings(this.settings);
        this.schedulePull();
        await this.savePluginData();
    }

    private async savePluginData(): Promise<void> {
        await this.saveData({
            settings: this.settings,
            syncState: this.syncState,
        });
    }

    private updateStatus(status: string): void {
        const display: Record<string, string> = {
            idle: 'Mengram: idle',
            syncing: 'Mengram: syncing...',
            synced: 'Mengram: synced',
            error: 'Mengram: error',
        };

        if (status.startsWith('syncing ')) {
            this.statusBarEl.setText(`Mengram: ${status}`);
            return;
        }

        this.statusBarEl.setText(display[status] || `Mengram: ${status}`);

        if (status === 'synced') {
            window.setTimeout(() => {
                if (this.statusBarEl.getText() === 'Mengram: synced') {
                    this.statusBarEl.setText('Mengram: idle');
                }
            }, 3000);
        }
    }

    private async syncCurrentFile(file: TFile): Promise<void> {
        if (!this.client) {
            new Notice('Mengram: please configure your API key in settings');
            return;
        }

        new Notice(`Mengram: syncing ${file.basename}...`);
        const success = await this.syncEngine.syncFile(file);
        if (success) {
            new Notice(`Mengram: ${file.basename} synced`);
        }
    }

    private async syncVault(): Promise<void> {
        if (!this.client) {
            new Notice('Mengram: please configure your API key in settings');
            return;
        }

        // One notice for the whole run, rewritten in place. A vault sync is
        // paced against the account's rate limit and can take half an hour, so
        // a toast that vanishes after a few seconds leaves the rest of it
        // looking like nothing is happening.
        const notice = new Notice(this.syncEngine.describeVaultSync(), 0);

        const result = await this.syncEngine.syncVault(
            progress => notice.setMessage(progress)
        );

        const parts = [`${result.synced} synced`];
        if (result.skipped) parts.push(`${result.skipped} unchanged`);
        if (result.errors) parts.push(`${result.errors} failed`);
        notice.setMessage(
            `Mengram: done — ${parts.join(', ')}.` +
            (result.errors ? ' See the developer console for what failed.' : '')
        );
        window.setTimeout(() => notice.hide(), result.errors ? 15000 : 6000);
    }

    /** Re-arms the background pull. Called on load and whenever settings change,
     *  so switching the interval takes effect without a restart. */
    private schedulePull(): void {
        if (this.pullTimer !== null) {
            window.clearInterval(this.pullTimer);
            this.pullTimer = null;
        }
        const minutes = this.settings.pullIntervalMin;
        if (!minutes || minutes <= 0) return;
        this.pullTimer = window.setInterval(
            () => void this.pullMemory({ quiet: true }),
            minutes * 60_000,
        );
        this.registerInterval(this.pullTimer);
    }

    /** Bring memory into the vault as files.
     *
     *  `quiet` is for the background run: it should say nothing unless
     *  something actually changed or broke. A notification every ten minutes
     *  reporting that nothing happened is how people turn a feature off. */
    private async pullMemory(options: { quiet?: boolean } = {}): Promise<void> {
        if (!this.client) {
            if (!options.quiet) {
                new Notice('Mengram: please configure your API key in settings');
            }
            return;
        }

        const notice = options.quiet ? null : new Notice('Mengram: pulling memory…', 0);
        try {
            const result = await this.pullEngine.pull(
                line => notice?.setMessage(line)
            );

            const changed = result.written + result.removed;
            if (options.quiet) {
                if (changed) {
                    new Notice(`Mengram: pulled ${result.written} updated, ${result.removed} removed`);
                }
                return;
            }

            const parts = [`${result.written} written`];
            if (result.unchanged) parts.push(`${result.unchanged} already current`);
            if (result.removed) parts.push(`${result.removed} removed`);
            notice?.setMessage(`Mengram: ${parts.join(', ')} in ${this.settings.pullFolder}/`);
            window.setTimeout(() => notice?.hide(), 6000);
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            console.error('Mengram: pull failed:', error);
            notice?.hide();
            new Notice(`Mengram: pull failed — ${error.message}`, 10000);
        }
    }

    private async showStats(): Promise<void> {
        if (!this.client) {
            new Notice('Mengram: please configure your API key in settings');
            return;
        }

        try {
            const stats = await this.client.stats({ userId: this.settings.userId });
            new Notice(
                `Mengram stats:\n` +
                `Entities: ${stats.entities}\n` +
                `Facts: ${stats.facts}\n` +
                `Knowledge: ${stats.knowledge}\n` +
                `Relations: ${stats.relations}`,
                10000
            );
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            new Notice(`Mengram: failed to get stats: ${error.message}`);
        }
    }
}
