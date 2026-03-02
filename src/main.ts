import { Plugin, TFile, Notice } from 'obsidian';
import { MengramClient } from './mengram-client';
import { MengramSettings, DEFAULT_SETTINGS, MengramSettingTab } from './settings';
import { SyncEngine, SyncState } from './sync';
import { MengramSearchModal } from './search-modal';

interface MengramPluginData {
    settings: MengramSettings;
    syncState: SyncState;
}

export default class MengramPlugin extends Plugin {
    settings: MengramSettings = DEFAULT_SETTINGS;
    private syncEngine!: SyncEngine;
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

        // Auto-sync on file modify
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) {
                    this.syncEngine.onFileModified(file);
                }
            })
        );

        // Clean up hash when file is deleted
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) {
                    delete this.syncState.fileHashes[file.path];
                }
            })
        );

        // Update hash key when file is renamed
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile && this.syncState.fileHashes[oldPath]) {
                    this.syncState.fileHashes[file.path] = this.syncState.fileHashes[oldPath];
                    delete this.syncState.fileHashes[oldPath];
                }
            })
        );

        // Command: Search memories
        this.addCommand({
            id: 'search-memories',
            name: 'Search memories',
            callback: () => {
                if (!this.client) {
                    new Notice('Mengram: Please configure your API key in settings');
                    return;
                }
                new MengramSearchModal(
                    this.app,
                    this.client,
                    this.settings.userId,
                ).open();
            },
        });

        // Command: Sync current file
        this.addCommand({
            id: 'sync-current-file',
            name: 'Sync current file',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file && file.extension === 'md') {
                    if (!checking) {
                        this.syncCurrentFile(file);
                    }
                    return true;
                }
                return false;
            },
        });

        // Command: Sync entire vault
        this.addCommand({
            id: 'sync-vault',
            name: 'Sync entire vault',
            callback: () => this.syncVault(),
        });

        // Command: Show stats
        this.addCommand({
            id: 'show-stats',
            name: 'Show memory stats',
            callback: () => this.showStats(),
        });

        this.addSettingTab(new MengramSettingTab(this.app, this));

        console.log('Mengram plugin loaded');
    }

    onunload(): void {
        this.syncEngine?.destroy();
        console.log('Mengram plugin unloaded');
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
    }

    async saveSettings(): Promise<void> {
        this.syncEngine?.updateSettings(this.settings);
        await this.savePluginData();
    }

    private async savePluginData(): Promise<void> {
        await this.saveData({
            settings: this.settings,
            syncState: this.syncState,
        } as MengramPluginData);
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
            setTimeout(() => {
                if (this.statusBarEl.getText() === 'Mengram: synced') {
                    this.statusBarEl.setText('Mengram: idle');
                }
            }, 3000);
        }
    }

    private async syncCurrentFile(file: TFile): Promise<void> {
        if (!this.client) {
            new Notice('Mengram: Please configure your API key in settings');
            return;
        }

        new Notice(`Mengram: Syncing ${file.basename}...`);
        const success = await this.syncEngine.syncFile(file);
        if (success) {
            new Notice(`Mengram: ${file.basename} synced`);
        }
    }

    private async syncVault(): Promise<void> {
        if (!this.client) {
            new Notice('Mengram: Please configure your API key in settings');
            return;
        }

        new Notice('Mengram: Starting vault sync...');

        const result = await this.syncEngine.syncVault();

        new Notice(
            `Mengram: Vault sync complete. ` +
            `Synced: ${result.synced}, Skipped: ${result.skipped}, Errors: ${result.errors}`
        );
    }

    private async showStats(): Promise<void> {
        if (!this.client) {
            new Notice('Mengram: Please configure your API key in settings');
            return;
        }

        try {
            const stats = await this.client.stats({ userId: this.settings.userId });
            new Notice(
                `Mengram Stats:\n` +
                `Entities: ${stats.entities}\n` +
                `Facts: ${stats.facts}\n` +
                `Knowledge: ${stats.knowledge}\n` +
                `Relations: ${stats.relations}`,
                10000
            );
        } catch (err: any) {
            new Notice(`Mengram: Failed to get stats: ${err.message}`);
        }
    }
}
