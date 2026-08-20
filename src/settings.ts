import { App, PluginSettingTab, Setting } from 'obsidian';
import type MengramPlugin from './main';

export interface MengramSettings {
    apiKey: string;
    autoSync: boolean;
    syncFolders: string;
    excludedFolders: string;
    debounceMs: number;
    userId: string;
    baseUrl: string;
    /** Vault folder the memory is written into. Generated: anything you edit
     *  in here is replaced on the next pull. */
    pullFolder: string;
    /** Minutes between automatic pulls. 0 turns them off and leaves the
     *  command as the only way to refresh. */
    pullIntervalMin: number;
}

export const DEFAULT_SETTINGS: MengramSettings = {
    apiKey: '',
    autoSync: true,
    syncFolders: '',
    excludedFolders: '.trash',
    debounceMs: 2000,
    userId: 'default',
    baseUrl: 'https://mengram.io',
    pullFolder: 'Mengram',
    pullIntervalMin: 0,
};

export class MengramSettingTab extends PluginSettingTab {
    plugin: MengramPlugin;

    constructor(app: App, plugin: MengramPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('API key')
            .setDesc('Your API key (starts with `om-`). Get one at mengram.io/dashboard.')
            .addText(text => {
                text.setPlaceholder('Enter API key');
                text.setValue(this.plugin.settings.apiKey);
                text.inputEl.type = 'password';
                text.onChange(async (value) => {
                    this.plugin.settings.apiKey = value.trim();
                    await this.plugin.saveSettings();
                    this.plugin.reinitClient();
                });
            });

        new Setting(containerEl)
            .setName('Auto-sync on save')
            .setDesc('Sync notes automatically when you save them.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sync folders')
            .setDesc('Only sync notes in these folders (comma-separated). Leave empty to sync all.')
            .addText(text => text
                .setPlaceholder('Notes, projects, journal')
                .setValue(this.plugin.settings.syncFolders)
                .onChange(async (value) => {
                    this.plugin.settings.syncFolders = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Excluded folders')
            .setDesc('Never sync notes in these folders (comma-separated).')
            .addText(text => text
                .setPlaceholder('.trash,templates')
                .setValue(this.plugin.settings.excludedFolders)
                .onChange(async (value) => {
                    this.plugin.settings.excludedFolders = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Debounce delay (seconds)')
            .setDesc('Wait this many seconds after editing before syncing.')
            .addSlider(slider => slider
                .setLimits(1, 10, 1)
                .setValue(this.plugin.settings.debounceMs / 1000)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.debounceMs = value * 1000;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('User ID')
            .setDesc('Isolate memories per user (for multi-user setups).')
            .addText(text => text
                .setPlaceholder('Default')
                .setValue(this.plugin.settings.userId)
                .onChange(async (value) => {
                    this.plugin.settings.userId = value.trim() || 'default';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Base URL')
            .setDesc('API base URL. Only change for self-hosted instances.')
            .addText(text => text
                .setPlaceholder('https://mengram.io')
                .setValue(this.plugin.settings.baseUrl)
                .onChange(async (value) => {
                    this.plugin.settings.baseUrl = value.trim() || 'https://mengram.io';
                    await this.plugin.saveSettings();
                    this.plugin.reinitClient();
                }));

        containerEl.createEl('h3', { text: 'Memory in your vault' });
        containerEl.createEl('p', {
            text: 'Pull writes your memory into the vault as Markdown — a file per '
                + 'entity, relations as links, so the graph view works on it. That '
                + 'folder is generated: edits inside it are replaced on the next '
                + 'pull. Edit your own notes instead; those sync the other way.',
            cls: 'setting-item-description',
        });

        new Setting(containerEl)
            .setName('Memory folder')
            .setDesc('Where pulled memory is written. Generated — do not keep your own notes here.')
            .addText(text => text
                .setPlaceholder('Mengram')
                .setValue(this.plugin.settings.pullFolder)
                .onChange(async (value) => {
                    this.plugin.settings.pullFolder = value.trim() || 'Mengram';
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Pull automatically')
            .setDesc('Minutes between background pulls. 0 keeps it manual — run "Pull memory into vault" when you want it.')
            .addText(text => text
                .setPlaceholder('0')
                .setValue(String(this.plugin.settings.pullIntervalMin))
                .onChange(async (value) => {
                    const minutes = Number(value);
                    this.plugin.settings.pullIntervalMin =
                        Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0;
                    await this.plugin.saveSettings();
                }));
    }
}
