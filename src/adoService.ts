import * as vscode from 'vscode';
import * as azdev from 'azure-devops-node-api';
import { WorkItem, WorkItemExpand } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';
import { TeamContext } from 'azure-devops-node-api/interfaces/CoreInterfaces';

export class AdoService {
    private connection: azdev.WebApi | null = null;
    private config: any = {};
    private cache = new Map<string, {data: any, timestamp: number}>();
    private stateCache = new Map<string, string[]>();
    private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    /** Escape a string value for safe interpolation into WIQL string literals. */
    private escapeWiql(value: string): string {
        return value.replace(/'/g, "''");
    }

    constructor() {
        this.loadConfig();
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('adoBacklog')) {
                this.loadConfig();
                this.clearCache(); // Clear cache when config changes
            }
        });
    }

    clearCache(): void {
        this.cache.clear();
        this.stateCache.clear();
    }

    private getCached<T>(key: string): T | null {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return cached.data as T;
        }
        return null;
    }

    private setCache(key: string, data: any): void {
        this.cache.set(key, {data, timestamp: Date.now()});
    }

    private loadConfig() {
        const config = vscode.workspace.getConfiguration('adoBacklog');
        this.config = {
            organizationUrl: config.get<string>('organizationUrl'),
            pat: config.get<string>('personalAccessToken'),
            project: config.get<string>('project'),
            areaPaths: config.get<string[]>('areaPaths') || []
        };

        if (this.isConfigured()) {
            const authHandler = azdev.getPersonalAccessTokenHandler(this.config.pat);
            this.connection = new azdev.WebApi(this.config.organizationUrl, authHandler);
        }
    }

    isConfigured(): boolean {
        return !!(this.config.organizationUrl && this.config.pat && this.config.project);
    }

    async getTeams(): Promise<any[]> {
        if (!this.connection) return [];

        if (this.config.areaPaths && this.config.areaPaths.length > 0) {
            return this.config.areaPaths.map((path: string) => ({
                name: path.split('\\').pop() || path, // Get last segment
                fullPath: path
            }));
        }

        // If no area paths configured, return empty (require configuration)
        return [];
    }

    getCustomFieldNames(): string[] {
        const config = vscode.workspace.getConfiguration('adoBacklog');
        const customFields = config.get<any[]>('customFields') || [];
        const names = new Set<string>();
        for (const field of customFields) {
            if (field.fieldReferenceName) {
                names.add(field.fieldReferenceName);
            }
        }
        return Array.from(names);
    }

    async getWorkItem(id: number): Promise<WorkItem | null> {
        if (!this.connection) { return null; }
        const witApi = await this.connection.getWorkItemTrackingApi();
        const fields = [
            'System.Id', 'System.Title', 'System.State',
            'System.WorkItemType',
            'System.AreaPath', 'System.IterationPath', 'System.AssignedTo',
            'System.Tags', 'System.Description', 'Microsoft.VSTS.Common.AcceptanceCriteria',
            'Microsoft.VSTS.Scheduling.StoryPoints',
            ...this.getCustomFieldNames()
        ];
        const workItem = await witApi.getWorkItem(id, fields);
        return workItem || null;
    }

    async getEpicsForTeam(
        areaPathName: string,
        filters?: {
            searchText?: string;
            iteration?: string;
            tags?: string[];
            assignedTo?: string;
        }
    ): Promise<WorkItem[]> {
        if (!this.connection) return [];

        // Build cache key that includes filters
        const filterKey = filters ? JSON.stringify(filters) : 'nofilters';
        const cacheKey = `epics_${areaPathName}_${filterKey}`;
        const cached = this.getCached<WorkItem[]>(cacheKey);
        if (cached) return cached;

        const witApi = await this.connection.getWorkItemTrackingApi();

        // Use the full path if available, otherwise construct it
        const areaPath = areaPathName.includes('\\') ? areaPathName : `${this.config.project}\\${areaPathName}`;

        // Build WHERE clause with filters
        let whereClause = `WHERE [System.TeamProject] = @project
            AND [System.WorkItemType] = 'Epic'
            AND [System.AreaPath] UNDER '${this.escapeWiql(areaPath)}'`;

        if (filters?.searchText) {
            const searchText = filters.searchText;
            // Check if it's a number (ID search) or text (title search)
            const parsedId = parseInt(searchText, 10);
            if (/^\d+$/.test(searchText) && isFinite(parsedId)) {
                whereClause += ` AND [System.Id] = ${parsedId}`;
            } else {
                whereClause += ` AND [System.Title] CONTAINS '${this.escapeWiql(searchText)}'`;
            }
        }

        if (filters?.iteration) {
            whereClause += ` AND [System.IterationPath] UNDER '${this.escapeWiql(filters.iteration)}'`;
        }

        if (filters?.tags && filters.tags.length > 0) {
            const tagConditions = filters.tags.map(tag => {
                return `([System.Tags] CONTAINS '${this.escapeWiql(tag)}')`;
            }).join(' AND ');
            whereClause += ` AND (${tagConditions})`;
        }

        if (filters?.assignedTo) {
            whereClause += ` AND [System.AssignedTo] CONTAINS '${this.escapeWiql(filters.assignedTo)}'`;
        }

        const wiql = {
            query: `SELECT [System.Id] FROM WorkItems
                ${whereClause}
                ORDER BY [System.Title]`
        };

        const result = await witApi.queryByWiql(wiql, { project: this.config.project });

        if (!result.workItems || result.workItems.length === 0) {
            this.setCache(cacheKey, []);
            return [];
        }

        const ids = result.workItems.map(wi => wi.id!);
        // Fetch only needed fields for performance
        const fields = [
            'System.Id', 'System.Title', 'System.State',
            'System.WorkItemType',
            'System.AreaPath', 'System.IterationPath', 'System.AssignedTo',
            'System.Tags', 'System.Description', 'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.Scheduling.StoryPoints',
            ...this.getCustomFieldNames()
        ];
        const workItems = await witApi.getWorkItems(ids, fields, undefined, undefined);

        const result2 = workItems || [];
        this.setCache(cacheKey, result2);

        // Pre-fetch children for epics if small set (performance optimization)
        if (result2.length > 0 && result2.length <= 10) {
            this.preFetchChildren(result2.map(wi => wi.id!));
        }

        return result2;
    }

    async getChildWorkItems(
        parentId: number,
        filters?: {
            searchText?: string;
            iteration?: string;
            tags?: string[];
            assignedTo?: string;
        }
    ): Promise<WorkItem[]> {
        if (!this.connection) return [];

        // Build cache key that includes filters
        const filterKey = filters ? JSON.stringify(filters) : 'nofilters';
        const cacheKey = `children_${parentId}_${filterKey}`;
        const cached = this.getCached<WorkItem[]>(cacheKey);
        if (cached) return cached;

        const witApi = await this.connection.getWorkItemTrackingApi();

        // Build WHERE clause for target work items with filters
        let targetConditions = '';

        if (filters?.searchText) {
            const searchText = filters.searchText;
            const parsedId = parseInt(searchText, 10);
            if (/^\d+$/.test(searchText) && isFinite(parsedId)) {
                targetConditions += ` AND [Target].[System.Id] = ${parsedId}`;
            } else {
                targetConditions += ` AND [Target].[System.Title] CONTAINS '${this.escapeWiql(searchText)}'`;
            }
        }

        if (filters?.iteration) {
            targetConditions += ` AND [Target].[System.IterationPath] UNDER '${this.escapeWiql(filters.iteration)}'`;
        }

        if (filters?.tags && filters.tags.length > 0) {
            const tagConditions = filters.tags.map(tag => {
                return `([Target].[System.Tags] CONTAINS '${this.escapeWiql(tag)}')`;
            }).join(' AND ');
            targetConditions += ` AND (${tagConditions})`;
        }

        if (filters?.assignedTo) {
            targetConditions += ` AND [Target].[System.AssignedTo] CONTAINS '${this.escapeWiql(filters.assignedTo)}'`;
        }

        const wiql = {
            query: `SELECT [System.Id] FROM WorkItemLinks
                WHERE ([Source].[System.Id] = ${parentId})
                AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')
                ${targetConditions}
                MODE (MustContain)`
        };

        const result = await witApi.queryByWiql(wiql, { project: this.config.project });

        if (!result.workItemRelations || result.workItemRelations.length <= 1) {
            this.setCache(cacheKey, []);
            return [];
        }

        const childIds = result.workItemRelations
            .slice(1) // Skip the parent
            .map(rel => rel.target?.id)
            .filter((id): id is number => id !== undefined);

        if (childIds.length === 0) {
            this.setCache(cacheKey, []);
            return [];
        }

        // Fetch only needed fields for performance
        const fields = [
            'System.Id', 'System.Title', 'System.State',
            'System.WorkItemType',
            'System.AreaPath', 'System.IterationPath', 'System.AssignedTo',
            'System.Tags', 'System.Description', 'Microsoft.VSTS.Common.AcceptanceCriteria', 'Microsoft.VSTS.Scheduling.StoryPoints',
            ...this.getCustomFieldNames()
        ];
        const workItems = await witApi.getWorkItems(childIds, fields, undefined, undefined);

        const result2 = workItems || [];
        this.setCache(cacheKey, result2);

        return result2;
    }

    async getBatchChildWorkItems(parentIds: number[]): Promise<Map<number, WorkItem[]>> {
        if (!this.connection) return new Map();

        const results = new Map<number, WorkItem[]>();
        const uncachedParents: number[] = [];

        // Check cache for each parent
        for (const parentId of parentIds) {
            const cached = this.getCached<WorkItem[]>(`children_${parentId}`);
            if (cached) {
                results.set(parentId, cached);
            } else {
                uncachedParents.push(parentId);
            }
        }

        if (uncachedParents.length === 0) {
            return results;
        }

        // Fetch all uncached children in parallel
        const promises = uncachedParents.map(parentId =>
            this.getChildWorkItems(parentId).then(children => ({
                parentId,
                children
            }))
        );

        const batchResults = await Promise.all(promises);
        for (const { parentId, children } of batchResults) {
            results.set(parentId, children);
        }

        return results;
    }

    async getAvailableStates(workItemType: string, currentState: string): Promise<string[]> {
        if (!this.connection) return [currentState];
        if (this.stateCache.has(workItemType)) {
            return this.stateCache.get(workItemType)!;
        }

        try {
            const witApi = await this.connection.getWorkItemTrackingApi();
            const workItemTypeObj = await witApi.getWorkItemType(this.config.project, workItemType);
            if (workItemTypeObj && workItemTypeObj.states) {
                const states = workItemTypeObj.states.map(s => s.name || '').filter(n => n);
                this.stateCache.set(workItemType, states);
                return states;
            }
        } catch (error) {
            console.error('Error fetching states:', error);
        }

        // Fallback to common states
        const fallbackStates = [currentState, 'New', 'Active', 'Resolved', 'Closed', 'Removed'];
        this.stateCache.set(workItemType, fallbackStates);
        return fallbackStates;
    }

    async getWorkItemTypeFields(workItemType: string): Promise<{
        referenceName: string;
        name: string;
        alwaysRequired: boolean;
        allowedValues: string[];
    }[]> {
        if (!this.connection) { return []; }

        const cacheKey = `witFields_${workItemType}`;
        const cached = this.getCached<any[]>(cacheKey);
        if (cached) { return cached; }

        try {
            const witApi = await this.connection.getWorkItemTrackingApi();
            // Expand AllowedValues (1) to include allowed values for each field
            const fieldInstances = await witApi.getWorkItemTypeFieldsWithReferences(
                this.config.project, workItemType, 1
            );
            const result = (fieldInstances || []).map((f: any) => ({
                referenceName: f.referenceName || '',
                name: f.name || '',
                alwaysRequired: !!f.alwaysRequired,
                allowedValues: f.allowedValues || []
            }));
            this.setCache(cacheKey, result);
            return result;
        } catch (error) {
            console.error(`Error fetching fields for ${workItemType}:`, error);
            return [];
        }
    }

    private async preFetchChildren(parentIds: number[]): Promise<void> {
        // Pre-fetch children in background (don't await)
        setTimeout(async () => {
            try {
                await this.getBatchChildWorkItems(parentIds);
            } catch (error) {
                // Silently fail - this is just optimization
            }
        }, 500); // Small delay to not block main operation
    }

    async updateWorkItem(workItemId: number, fields: { [key: string]: any }): Promise<void> {
        if (!this.connection) throw new Error('Not connected to Azure DevOps');

        const witApi = await this.connection.getWorkItemTrackingApi();

        const patchDocument = Object.keys(fields).map(fieldName => ({
            op: fieldName === 'System.Tags' ? 'replace' : 'add',
            path: `/fields/${fieldName}`,
            value: fields[fieldName]
        }));

        await witApi.updateWorkItem(
            undefined,
            patchDocument,
            workItemId,
            this.config.project
        );

        // Invalidate cache for this work item's parent
        this.invalidateWorkItemCache(workItemId);
    }

    async deleteWorkItem(workItemId: number): Promise<void> {
        if (!this.connection) throw new Error('Not connected to Azure DevOps');

        const witApi = await this.connection.getWorkItemTrackingApi();

        await witApi.deleteWorkItem(workItemId, this.config.project);

        // Invalidate cache for this work item's parent
        this.invalidateWorkItemCache(workItemId);
    }

    invalidateWorkItemCache(workItemId: number): void {
        // Remove specific work item cache and its children
        this.cache.delete(`children_${workItemId}`);

        // Also invalidate any parent caches (less granular but ensures consistency)
        // Could be improved by tracking parent relationships
        const keysToDelete: string[] = [];
        this.cache.forEach((_, key) => {
            if (key.startsWith('children_') || key.startsWith('epics_')) {
                keysToDelete.push(key);
            }
        });
        keysToDelete.forEach(key => this.cache.delete(key));
    }

    async createWorkItem(
        workItemType: string,
        fields: { [key: string]: any },
        parentId?: number
    ): Promise<WorkItem> {
        if (!this.connection) throw new Error('Not connected to Azure DevOps');

        const witApi = await this.connection.getWorkItemTrackingApi();

        const patchDocument: any[] = Object.keys(fields).map(fieldName => ({
            op: 'add',
            path: `/fields/${fieldName}`,
            value: fields[fieldName]
        }));

        // Add parent link if specified
        if (parentId) {
            patchDocument.push({
                op: 'add',
                path: '/relations/-',
                value: {
                    rel: 'System.LinkTypes.Hierarchy-Reverse',
                    url: `${this.config.organizationUrl}/${this.config.project}/_apis/wit/workItems/${parentId}`,
                    attributes: { comment: 'Parent work item' }
                }
            });
        }

        const newWorkItem = await witApi.createWorkItem(
            undefined,
            patchDocument,
            this.config.project,
            workItemType
        );

        // Invalidate cache so the new item shows up in the tree
        this.invalidateWorkItemCache(newWorkItem!.id!);

        return newWorkItem!;
    }

    async removeParentLink(workItemId: number): Promise<void> {
        if (!this.connection) throw new Error('Not connected to Azure DevOps');

        const witApi = await this.connection.getWorkItemTrackingApi();

        // Get current work item with relations to find parent link
        const workItem = await witApi.getWorkItem(workItemId, undefined, undefined, WorkItemExpand.Relations);

        if (workItem.relations) {
            const parentRelation = workItem.relations.find(rel =>
                rel.rel === 'System.LinkTypes.Hierarchy-Reverse'
            );

            if (parentRelation) {
                const relationIndex = workItem.relations.indexOf(parentRelation);
                const patchDocument = [{
                    op: 'remove',
                    path: `/relations/${relationIndex}`
                }];

                await witApi.updateWorkItem(
                    undefined,
                    patchDocument,
                    workItemId,
                    this.config.project
                );
            }
        }

        // Invalidate cache after removing parent link
        this.invalidateWorkItemCache(workItemId);
    }

    async addParentLink(workItemId: number, parentId: number): Promise<void> {
        if (!this.connection) throw new Error('Not connected to Azure DevOps');

        const witApi = await this.connection.getWorkItemTrackingApi();

        const patchDocument = [{
            op: 'add',
            path: '/relations/-',
            value: {
                rel: 'System.LinkTypes.Hierarchy-Reverse',
                url: `${this.config.organizationUrl}/${this.config.project}/_apis/wit/workItems/${parentId}`,
                attributes: { comment: 'Reparented via drag and drop' }
            }
        }];

        await witApi.updateWorkItem(
            undefined,
            patchDocument,
            workItemId,
            this.config.project
        );

        // Invalidate cache after adding parent link
        this.invalidateWorkItemCache(workItemId);
    }

    async getAllTeamMembers(): Promise<{displayName: string, uniqueName: string, id: string}[]> {
        const cacheKey = 'allTeamMembers';
        const cached = this.getCached<{displayName: string, uniqueName: string, id: string}[]>(cacheKey);
        if (cached) return cached;

        const seen = new Map<string, {displayName: string, uniqueName: string, id: string}>();

        for (const areaPath of this.config.areaPaths || []) {
            const teamName = areaPath.split('\\').pop() || areaPath;
            try {
                const members = await this.getTeamMembers(teamName);
                for (const m of members) {
                    if (m.uniqueName && !seen.has(m.uniqueName)) {
                        seen.set(m.uniqueName, m);
                    }
                }
            } catch {
                // Skip teams that fail to load
            }
        }

        const result = Array.from(seen.values());
        this.setCache(cacheKey, result);
        return result;
    }

    async getTeamMembers(teamName: string): Promise<any[]> {
        if (!this.connection) return [];

        try {
            const coreApi = await this.connection.getCoreApi();
            const teams = await coreApi.getTeams(this.config.project);

            // Find team by name (matching the last segment of area path)
            const team = teams.find(t => t.name === teamName);
            if (!team) {
                return [];
            }

            // Get team members
            const members = await coreApi.getTeamMembersWithExtendedProperties(
                this.config.project,
                team.id!
            );

            return members.map(member => ({
                displayName: member.identity?.displayName || 'Unknown',
                uniqueName: member.identity?.uniqueName || '',
                id: member.identity?.id || ''
            }));
        } catch (error) {
            console.error('Error fetching team members:', error);
            return [];
        }
    }
}
