import { App, Modal, MarkdownView, normalizePath } from 'obsidian';
import { MengramClient, SearchResult } from './mengram-client';

export class MengramSearchModal extends Modal {
    private client: MengramClient;
    private userId: string;
    private resultsEl!: HTMLElement;
    private inputEl!: HTMLInputElement;
    private searchTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor(app: App, client: MengramClient, userId: string) {
        super(app);
        this.client = client;
        this.userId = userId;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('mengram-search-modal');

        contentEl.createEl('h2', { text: 'Search memories' });

        const inputContainer = contentEl.createDiv({ cls: 'mengram-search-input-container' });
        this.inputEl = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search your memories...',
            cls: 'mengram-search-input',
        });
        this.inputEl.focus();

        this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void this.doSearch(this.inputEl.value);
            }
        });

        this.inputEl.addEventListener('input', () => {
            if (this.searchTimeout) clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                const query = this.inputEl.value.trim();
                if (query.length >= 3) {
                    void this.doSearch(query);
                }
            }, 500);
        });

        this.resultsEl = contentEl.createDiv({ cls: 'mengram-search-results' });
    }

    private async doSearch(query: string): Promise<void> {
        if (!query.trim()) return;

        this.resultsEl.empty();
        this.resultsEl.createEl('p', { text: 'Searching...', cls: 'mengram-search-loading' });

        try {
            const results = await this.client.search(query, {
                userId: this.userId,
                limit: 10,
            });

            this.resultsEl.empty();

            if (results.length === 0) {
                this.resultsEl.createEl('p', {
                    text: 'No results found.',
                    cls: 'mengram-search-empty',
                });
                return;
            }

            for (const result of results) {
                this.renderResult(result);
            }
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.resultsEl.empty();
            this.resultsEl.createEl('p', {
                text: `Search failed: ${error.message}`,
                cls: 'mengram-search-error',
            });
        }
    }

    private renderResult(result: SearchResult): void {
        const card = this.resultsEl.createDiv({ cls: 'mengram-result-card' });

        const header = card.createDiv({ cls: 'mengram-result-header' });
        header.createEl('span', { text: result.entity, cls: 'mengram-result-entity' });
        header.createEl('span', { text: result.type, cls: 'mengram-result-type' });
        header.createEl('span', {
            text: `${Math.round(result.score * 100)}%`,
            cls: 'mengram-result-score',
        });

        if (result.facts && result.facts.length > 0) {
            const factsList = card.createEl('ul', { cls: 'mengram-result-facts' });
            for (const fact of result.facts.slice(0, 5)) {
                factsList.createEl('li', { text: fact });
            }
            if (result.facts.length > 5) {
                factsList.createEl('li', {
                    text: `... and ${result.facts.length - 5} more`,
                    cls: 'mengram-result-more',
                });
            }
        }

        card.addEventListener('click', () => {
            this.insertResult(result);
        });

        card.setAttribute('title', 'Click to insert into current note');
    }

    private insertResult(result: SearchResult): void {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
            void this.createNoteFromResult(result);
            return;
        }

        const editor = activeView.editor;
        const cursor = editor.getCursor();

        const lines: string[] = [
            `## ${result.entity} (${result.type})`,
            '',
        ];
        for (const fact of result.facts) {
            lines.push(`- ${fact}`);
        }
        lines.push('');

        editor.replaceRange(lines.join('\n'), cursor);
        this.close();
    }

    private async createNoteFromResult(result: SearchResult): Promise<void> {
        const lines: string[] = [
            `# ${result.entity}`,
            '',
            `**Type:** ${result.type}`,
            `**Score:** ${Math.round(result.score * 100)}%`,
            '',
            '## Facts',
            '',
        ];
        for (const fact of result.facts) {
            lines.push(`- ${fact}`);
        }

        const fileName = normalizePath(`${result.entity.replace(/[\\/:*?"<>|]/g, '_')}.md`);
        try {
            const file = await this.app.vault.create(fileName, lines.join('\n'));
            await this.app.workspace.openLinkText(file.path, '', true);
        } catch {
            await this.app.workspace.openLinkText(fileName, '', true);
        }
        this.close();
    }

    onClose(): void {
        if (this.searchTimeout) clearTimeout(this.searchTimeout);
        const { contentEl } = this;
        contentEl.empty();
    }
}
