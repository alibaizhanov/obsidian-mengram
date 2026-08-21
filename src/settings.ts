import { App, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
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

    /** Declares every setting so Obsidian 1.13+ can find them from its own
     *  settings search. Without this the panel still renders, but someone
     *  typing "mengram" or "api key" into search gets nothing — and a setting
     *  nobody can find may as well not exist.
     *
     *  display() below still draws the panel, and both read the same values
     *  through getControlValue/setControlValue, so the two cannot disagree. */
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                name: 'API key',
                desc: 'Your API key (starts with `om-`). Get one at mengram.io/dashboard.',
                control: { type: 'text', key: 'apiKey', placeholder: 'om-…' },
            },
            {
                name: 'Auto-sync on save',
                desc: 'Send a note to memory shortly after you stop editing it.',
                control: { type: 'toggle', key: 'autoSync' },
            },
            {
                name: 'Sync folders',
                desc: 'Only sync these folders, comma-separated. Empty means the whole vault.',
                control: { type: 'text', key: 'syncFolders', placeholder: 'Projects, Notes' },
            },
            {
                name: 'Excluded folders',
                desc: 'Never sync these folders, comma-separated.',
                control: { type: 'text', key: 'excludedFolders', placeholder: '.trash' },
            },
            {
                name: 'Debounce delay',
                desc: 'Milliseconds to wait after your last keystroke before syncing.',
                control: { type: 'number', key: 'debounceMs', placeholder: '2000' },
            },
            {
                name: 'User ID',
                desc: 'Keeps separate people apart on one account.',
                control: { type: 'text', key: 'userId', placeholder: 'default' },
            },
            {
                name: 'Base URL',
                desc: 'API base URL. Only change for self-hosted instances.',
                control: { type: 'text', key: 'baseUrl', placeholder: 'https://mengram.io' },
            },
            {
                name: 'Memory folder',
                desc: 'Where pulled memory is written. Generated — do not keep your own notes here.',
                control: { type: 'text', key: 'pullFolder', placeholder: 'Mengram' },
            },
            {
                name: 'Pull automatically',
                desc: 'Minutes between background pulls. 0 keeps it manual.',
                control: { type: 'number', key: 'pullIntervalMin', placeholder: '0' },
            },
        ];
    }

    getControlValue(key: string): unknown {
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        const settings = this.plugin.settings as unknown as Record<string, unknown>;
        settings[key] = value;
        await this.plugin.saveSettings();
        // The key and the base URL decide which server the client talks to, so
        // changing either has to rebuild it or the next call goes to the old one.
        if (key === 'apiKey' || key === 'baseUrl') this.plugin.reinitClient();
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
