import * as vscode from 'vscode';
import { WorkItem } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import { AdoService } from './adoService';

const PAGE_SIZE = 50;

class BacklogItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'team' | 'epic' | 'feature' | 'userstory' | 'bug' | 'loadMore',
        public readonly workItem?: WorkItem,
        public readonly teamName?: string
    ) {
        super(label, collapsibleState);

        this.tooltip = workItem ? `ID: ${workItem.id} - ${workItem.fields!['System.State']}` : label;

        if (workItem) {
            const stateIndicatorList = vscode.workspace.getConfiguration('adoBacklog').get<{state: string, indicator: string}[]>('stateIndicators') || [];
            const state = workItem.fields!['System.State'] || '';
            const match = stateIndicatorList.find(s => s.state === state) || stateIndicatorList.find(s => s.state === '*');
            const indicator = match?.indicator || '';
            this.description = indicator ? `${indicator} #${workItem.id}` : `#${workItem.id}`;
        } else {
            this.description = '';
        }

        if (type === 'team') {
            this.contextValue = 'areaPath';

            this.command = {
                command: 'adoBacklog.showTeamInfo',
                title: 'Show Team Information',
                arguments: [this]
            };
        } else if (type === 'epic') {
            this.contextValue = 'epic workItem';
        } else if (type === 'feature') {
            this.contextValue = 'feature workItem';
        } else if (type === 'userstory') {
            this.contextValue = 'workItem';
        } else if (type === 'bug') {
            this.contextValue = 'bug workItem';
        }

        if (workItem) {
            this.command = {
                command: 'adoBacklog.openItem',
                title: 'Open Work Item',
                arguments: [this]
            };
        }

        this.iconPath = new vscode.ThemeIcon(this.getIcon(), this.getIconColor());
    }

    private getIcon(): string {
        switch (this.type) {
            case 'team': return 'organization';
            case 'epic': return 'milestone';
            case 'feature': return 'package';
            case 'userstory': return 'checklist';
            case 'bug': return 'bug';
            default: return 'circle-outline';
        }
    }

    private getIconColor(): vscode.ThemeColor {
        switch (this.type) {
            case 'team': return new vscode.ThemeColor('charts.red');
            case 'epic': return new vscode.ThemeColor('charts.orange');
            case 'feature': return new vscode.ThemeColor('charts.purple');
            case 'userstory': return new vscode.ThemeColor('charts.blue');
            case 'bug': return new vscode.ThemeColor('charts.red');
            default: return new vscode.ThemeColor('foreground');
        }
    }
}

export class AdoBacklogProvider implements vscode.TreeDataProvider<BacklogItem>, vscode.TreeDragAndDropController<BacklogItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<BacklogItem | undefined | null | void> = new vscode.EventEmitter<BacklogItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<BacklogItem | undefined | null | void> = this._onDidChangeTreeData.event;

    dropMimeTypes = ['application/vnd.code.tree.adoBacklog'];
    dragMimeTypes = ['application/vnd.code.tree.adoBacklog'];

    private searchText: string = '';
    private iterationFilter: string = '';
    private tagsFilter: string[] = [];
    private assignedToFilter: string = '';
    private refreshTimeout?: NodeJS.Timeout;
    private loadedCounts: Map<string, number> = new Map();

    constructor(private adoService: AdoService) { }

    setSearchText(text: string): void {
        this.searchText = text;
        this.refresh();
    }

    setIterationFilter(iteration: string): void {
        this.iterationFilter = iteration;
        this.refresh();
    }

    setTagsFilter(tags: string[]): void {
        this.tagsFilter = tags;
        this.refresh();
    }

    setAssignedToFilter(assignedTo: string): void {
        this.assignedToFilter = assignedTo;
        this.refresh();
    }

    clearFilters(): void {
        this.searchText = '';
        this.iterationFilter = '';
        this.tagsFilter = [];
        this.assignedToFilter = '';
        this.refresh();
    }

    getActiveFilters(): string {
        const filters: string[] = [];
        if (this.searchText) filters.push(`Search: "${this.searchText}"`);
        if (this.iterationFilter) filters.push(`Iteration: ${this.iterationFilter}`);
        if (this.tagsFilter.length > 0) filters.push(`Tags: ${this.tagsFilter.join(', ')}`);
        if (this.assignedToFilter) filters.push(`Assigned To: ${this.assignedToFilter}`);
        return filters.length > 0 ? filters.join(' | ') : '';
    }

    refresh(element?: BacklogItem): void {
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }

        this.refreshTimeout = setTimeout(() => {
            this._onDidChangeTreeData.fire(element);
        }, 300);
    }

    refreshImmediate(element?: BacklogItem): void {
        this._onDidChangeTreeData.fire(element);
    }

    getTreeItem(element: BacklogItem): vscode.TreeItem {
        return element;
    }

    private getfiltersForService() {
        return {
            searchText: this.searchText || undefined, 
            iteration: this.iterationFilter || undefined,
            tags: this.tagsFilter.length > 0 ? this.tagsFilter : undefined, 
            assignedTo: this.assignedToFilter || undefined
        };
    }

    async getChildren(element?: BacklogItem): Promise<BacklogItem[]> {
        if (!this.adoService.isConfigured()) {
            vscode.window.showWarningMessage('Please configure Azure DevOps settings in VS Code settings');
            return [];
        }

        try {
            if (!element) {
                const areas = await this.adoService.getTeams();
                return areas.map(area => new BacklogItem(
                    area.name || 'Unknown Area',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'team',
                    undefined,
                    area.fullPath || area.name
                ));
            } else if (element.type === 'loadMore') {
                return [];
            } else if (element.type === 'team') {
                const filters = this.getfiltersForService();
                const epics = await this.adoService.getEpicsForTeam(element.teamName!, filters);
                return this.paginateItems(epics, 'team_' + element.teamName, 'epic', element.teamName);
            } else if (element.type === 'epic') {
                const filters = this.getfiltersForService();
                const features = await this.adoService.getChildWorkItems(element.workItem!.id!, filters);
                const filtered = features.filter(f => f.fields!['System.WorkItemType'] === 'Feature');
                return this.paginateItems(filtered, 'epic_' + element.workItem!.id, 'feature', element.teamName);
            } else if (element.type === 'feature') {
                // Return user stories and bugs for the feature - server-side filtered
                const filters = this.getfiltersForService();
                const children = await this.adoService.getChildWorkItems(element.workItem!.id!, filters);
                const stories = children.filter(s => s.fields!['System.WorkItemType'] === 'User Story');
                const bugs = children.filter(s => s.fields!['System.WorkItemType'] === 'Bug');
                const storyItems = stories.map(item => new BacklogItem(
                    item.fields!['System.Title'],
                    vscode.TreeItemCollapsibleState.None,
                    'userstory',
                    item,
                    element.teamName
                ));
                const bugItems = bugs.map(item => new BacklogItem(
                    item.fields!['System.Title'],
                    vscode.TreeItemCollapsibleState.None,
                    'bug',
                    item,
                    element.teamName
                ));

                const allItems = [...storyItems, ...bugItems];
                const parentKey = 'feature_' + element.workItem!.id;
                const loadedCount = this.loadedCounts.get(parentKey) || PAGE_SIZE;
                const itemsToShow = allItems.slice(0, loadedCount);
                // Add "Load More" item if there are more items
                if (allItems.length > loadedCount) {
                    const loadMoreItem = new BacklogItem(
                        `Load More... (${allItems.length - loadedCount} remaining)`,
                        vscode.TreeItemCollapsibleState.None,
                        'loadMore',
                        undefined,
                        element.teamName
                    );
                    loadMoreItem.command = {
                        command: 'adoBacklog.loadMore',
                        title: 'Load More',
                        arguments: [parentKey]
                    };
                    loadMoreItem.iconPath = new vscode.ThemeIcon('arrow-down');
                    itemsToShow.push(loadMoreItem);
                }
                return itemsToShow;
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error loading backlog: ${error.message}`);
            return [];
        }
        return [];
    }

    private paginateItems(items: WorkItem[], parentKey: string, itemType: string, teamName?: string): BacklogItem[] {
        const loadedCount = this.loadedCounts.get(parentKey) || PAGE_SIZE;
        const itemsToShow = items.slice(0, loadedCount);
        const result = itemsToShow.map(item => new BacklogItem(
            item.fields!['System.Title'],
            itemType === 'userstory' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
            itemType as any,
            item,
            teamName
        ));
        // Add "Load More" item if there are more items
        if (items.length > loadedCount) {
            const loadMoreItem = new BacklogItem(
                `Load More... (${items.length - loadedCount} remaining)`,
                vscode.TreeItemCollapsibleState.None,
                'loadMore',
                undefined,
                teamName
            );
            loadMoreItem.command = {
                command: 'adoBacklog.loadMore',
                title: 'Load More',
                arguments: [parentKey]
            };
            loadMoreItem.iconPath = new vscode.ThemeIcon('arrow-down');
            result.push(loadMoreItem);
        }
        return result;
    }

    loadMore(parentKey: string): void {
        const currentCount = this.loadedCounts.get(parentKey) || PAGE_SIZE;
        this.loadedCounts.set(parentKey, currentCount + PAGE_SIZE);
        this.refreshImmediate();
    }

    // Drag and Drop implementation
    async handleDrag(source: readonly BacklogItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        // Only allow dragging work items (not area paths)
        const draggableItems = source.filter(item => item.workItem);
        if (draggableItems.length > 0) {
            // Store as JSON string to ensure proper serialization
            const itemsData = draggableItems.map(item => ({
                id: item.workItem?.id,
                type: item.type,
                label: item.label,
                teamName: item.teamName
            }));
            dataTransfer.set('application/vnd.code.tree.adoBacklog', new vscode.DataTransferItem(itemsData));
        }
    }

    async handleDrop(target: BacklogItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        const transferItem = dataTransfer.get('application/vnd.code.tree.adoBacklog');
        if (!transferItem) {
            return;
        }
        const itemsData: any[] = transferItem.value;
        for (const itemData of itemsData) {
            if (!itemData.id) { continue; }
            const draggedType = itemData.type;
            const targetType = target?.type;
            // Strict validation rules
            if (draggedType === 'userstory' && targetType === 'feature') {
                // User Story -> Feature: OK
                await this.reparentWorkItemById(itemData.id, target!);
            } else if (draggedType === 'bug' && targetType === 'feature') {
                // Bug -> Feature: OK
                await this.reparentWorkItemById(itemData.id, target!);
            } else if (draggedType === 'feature' && targetType === 'epic') {
                // Feature -> Epic: OK
                await this.reparentWorkItemById(itemData.id, target!);
            } else if (draggedType === 'epic' && targetType === 'team') {
                // Epic -> Area Path: OK
                await this.reparentWorkItemById(itemData.id, target!);
            } else {
                // Invalid move
                vscode.window.showErrorMessage(
                    `Cannot move ${draggedType} to ${targetType}. ` +
                    `Valid moves: User Story→Feature, Bug→Feature, Feature→Epic, Epic→Area Path`
                );
            }
        }
        this.refresh();
    }

    private async reparentWorkItemById(workItemId: number, newParent: BacklogItem): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('adoBacklog');
            const orgUrl = config.get<string>('organizationUrl');
            const project = config.get<string>('project');
            if (!orgUrl || !project) {
                vscode.window.showErrorMessage('Organization URL or Project not configured');
                return;
            }
            // Remove existing parent link
            await this.adoService.removeParentLink(workItemId);
            // Add new parent link based on target type
            if (newParent.type === 'team') {
                // Moving Epic to Area Path - use teamName which has the full path
                const fullAreaPath = newParent.teamName || newParent.label;
                await this.adoService.updateWorkItem(workItemId, {
                    'System.AreaPath': fullAreaPath
                });
            } else if (newParent.workItem) {
                // Moving to another work item - add parent link
                await this.adoService.addParentLink(workItemId, newParent.workItem.id!);
            }
            vscode.window.showInformationMessage(
                `Work item #${workItemId} moved to ${newParent.label}`
            );
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to move work item: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

}