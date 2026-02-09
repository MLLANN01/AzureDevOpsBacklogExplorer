import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AdoBacklogProvider } from './adoBacklogProvider';
import { AdoService } from './adoService';

export function activate(context: vscode.ExtensionContext) {
    console.log('Azure DevOps Backlog Explorer is now active!');

    const adoService = new AdoService();
    const backlogProvider = new AdoBacklogProvider(adoService);

    // Track open detail panels by work item ID
    const openPanels = new Map<number, vscode.WebviewPanel>();

    // Eagerly warm the team members cache in the background
    adoService.getAllTeamMembers().catch(() => {});

    vscode.window.createTreeView('adoBacklog', {
        treeDataProvider: backlogProvider,
        dragAndDropController: backlogProvider
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.refresh', () => {
            adoService.clearCache();
            backlogProvider.refreshImmediate();
        })
    );

    // Refresh single work item and its children
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.refreshItem', async (item) => {
            if (item && item.workItem) {
                const workItemId = item.workItem.id!;
                adoService.invalidateWorkItemCache(workItemId);
                backlogProvider.refreshImmediate(item);

                // Refresh open detail panel if one exists for this work item
                const panel = openPanels.get(workItemId);
                if (panel) {
                    const freshWorkItem = await adoService.getWorkItem(workItemId);
                    if (freshWorkItem) {
                        const nonce = crypto.randomBytes(16).toString('base64');
                        const members = await adoService.getAllTeamMembers();
                        panel.webview.html = getWorkItemHtml(freshWorkItem, nonce, members);
                    }
                }
            }
        })
    );

    // Search command
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.search', async () => {
            const searchText = await vscode.window.showInputBox({
                prompt: 'Search work items by title or ID',
                placeHolder: 'Enter search text...',
                value: ''
            });

            if (searchText !== undefined) {
                backlogProvider.setSearchText(searchText);
                const filters = backlogProvider.getActiveFilters();
                if (filters) {
                    vscode.window.showInformationMessage(`Active filters: ${filters}`);
                }
            }
        })
    );

    // Filter by iteration
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.filterByIteration', async () => {
            const iteration = await vscode.window.showInputBox({
                prompt: 'Filter by iteration path',
                placeHolder: 'e.g., Sprint 1, 2026 Q1, etc.',
                value: ''
            });

            if (iteration !== undefined) {
                backlogProvider.setIterationFilter(iteration);
                const filters = backlogProvider.getActiveFilters();
                if (filters) {
                    vscode.window.showInformationMessage(`Active filters: ${filters}`);
                }
            }
        })
    );

    // Filter by tags
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.filterByTags', async () => {
            const tagsInput = await vscode.window.showInputBox({
                prompt: 'Filter by tags (comma-separated for multiple)',
                placeHolder: 'e.g., bug, high-priority',
                value: ''
            });

            if (tagsInput !== undefined) {
                const tags = tagsInput.split(',').map(t => t.trim()).filter(t => t);
                backlogProvider.setTagsFilter(tags);
                const filters = backlogProvider.getActiveFilters();
                if (filters) {
                    vscode.window.showInformationMessage(`Active filters: ${filters}`);
                }
            }
        })
    );

    // Filter by assigned to
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.filterByAssignedTo', async () => {
            const assignedTo = await vscode.window.showInputBox({
                prompt: 'Filter by assigned to (partial name match)',
                placeHolder: 'e.g., John Doe, joe@company.com',
                value: ''
            });

            if (assignedTo !== undefined) {
                backlogProvider.setAssignedToFilter(assignedTo);
                const filters = backlogProvider.getActiveFilters();
                if (filters) {
                    vscode.window.showInformationMessage(`Active filters: ${filters}`);
                }
            }
        })
    );

    // Clear all filters
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.clearFilters', () => {
            backlogProvider.clearFilters();
            vscode.window.showInformationMessage('All filters cleared');
        })
    );

    // Load more items
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.loadMore', (parentKey: string) => {
            backlogProvider.loadMore(parentKey);
        })
    );

    // Show team info
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.showTeamInfo', async (item) => {
            if (item && item.type === 'team') {
                const teamName = item.label;
                const members = await adoService.getTeamMembers(teamName);
                const nonce = crypto.randomBytes(16).toString('base64');

                const panel = vscode.window.createWebviewPanel(
                    'adoTeamInfo',
                    `Team: ${teamName}`,
                    vscode.ViewColumn.One,
                    {
                        enableScripts: true
                    }
                );

                panel.webview.html = getTeamInfoHtml(teamName, members, nonce);
            }
        })
    );

    // Open work item
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.openItem', async (item) => {
            if (item && item.workItem) {
                const nonce = crypto.randomBytes(16).toString('base64');
                const members = await adoService.getAllTeamMembers();
                const panel = vscode.window.createWebviewPanel(
                    'adoWorkItem',
                    `${item.workItem.fields['System.Title']}`,
                    vscode.ViewColumn.One,
                    {
                        enableScripts: true
                    }
                );

                const workItemId = item.workItem.id!;
                openPanels.set(workItemId, panel);
                panel.onDidDispose(() => { openPanels.delete(workItemId); });

                panel.webview.html = getWorkItemHtml(item.workItem, nonce, members);

                panel.webview.onDidReceiveMessage(
                    async message => {
                        switch (message.command) {
                            case 'getStates':
                                const states = await adoService.getAvailableStates(
                                    message.workItemType,
                                    message.currentState
                                );
                                panel.webview.postMessage({
                                    command: 'updateStates',
                                    states: states,
                                    currentState: message.currentState
                                });
                                return;
                            case 'save':
                                await adoService.updateWorkItem(item.workItem.id!, message.fields);
                                backlogProvider.refreshImmediate();
                                vscode.window.showInformationMessage(`Work Item #${item.workItem.id} updated successfully!`);
                                return;
                            case 'delete':
                                const confirmDelete = await vscode.window.showWarningMessage(
                                    `Delete work item #${item.workItem.id}?`,
                                    { modal: true },
                                    'Delete'
                                );
                                if (confirmDelete === 'Delete') {
                                    await adoService.deleteWorkItem(item.workItem.id!);
                                    vscode.window.showInformationMessage('Work item deleted');
                                    panel.dispose();
                                    backlogProvider.refreshImmediate();
                                }
                                return;
                        }
                    },
                    undefined,
                    context.subscriptions
                );
            }
        })
    );

    // Delete work item from context menu
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.deleteItem', async (item) => {
            if (item && item.workItem) {
                const confirmDelete = await vscode.window.showWarningMessage(
                    `Delete work item #${item.workItem.id}: ${item.workItem.fields['System.Title']}?`,
                    { modal: true },
                    'Delete'
                );
                if (confirmDelete === 'Delete') {
                    await adoService.deleteWorkItem(item.workItem.id!);
                    vscode.window.showInformationMessage('Work item deleted');
                    backlogProvider.refreshImmediate();
                }
            }
        })
    );

    // Change state from context menu
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.changeState', async (item) => {
            if (item && item.workItem) {
                const workItemType = item.workItem.fields['System.WorkItemType'];
                const currentState = item.workItem.fields['System.State'];
                const states = await adoService.getAvailableStates(workItemType, currentState);
                const selectedState = await vscode.window.showQuickPick(states, {
                    placeHolder: `Current state: ${currentState}`,
                    title: 'Select new state'
                });

                if (selectedState && selectedState !== currentState) {
                    await adoService.updateWorkItem(item.workItem.id!, { 'System.State': selectedState });
                    vscode.window.showInformationMessage(`State changed to ${selectedState}`);
                    backlogProvider.refreshImmediate();
                }
            }
        })
    );

    // Create New Epic (from area path)
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.createEpic', async (item) => {
            const title = await vscode.window.showInputBox({
                prompt: 'Enter Epic title',
                placeHolder: 'Epic title...'
            });

            if (!title) return;

            const customFieldValues = await promptRequiredCustomFields('Epic');
            if (customFieldValues === undefined) { return; }

            const areaPath = item.teamName || item.label;
            const config = vscode.workspace.getConfiguration('adoBacklog');
            const defaultIteration = config.get<string>('defaultIterationPath') || areaPath.split('\\')[0];

            try {
                const newEpic = await adoService.createWorkItem('Epic', {
                    'System.Title': title,
                    'System.AreaPath': areaPath,
                    'System.IterationPath': defaultIteration,
                    ...customFieldValues
                });

                vscode.window.showInformationMessage(`Epic #${newEpic.id} created: ${title}`);
                backlogProvider.refreshImmediate();
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to create Epic: ${error.message}`);
            }
        })
    );

    // Create New Feature (from epic)
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.createFeature', async (item) => {
            if (!item || !item.workItem) return;

            const title = await vscode.window.showInputBox({
                prompt: 'Enter Feature title',
                placeHolder: 'Feature title...'
            });

            if (!title) return;

            const customFieldValues = await promptRequiredCustomFields('Feature');
            if (customFieldValues === undefined) { return; }

            try {
                const newFeature = await adoService.createWorkItem('Feature', {
                    'System.Title': title,
                    'System.AreaPath': item.workItem.fields['System.AreaPath'],
                    'System.IterationPath': item.workItem.fields['System.IterationPath'],
                    ...customFieldValues
                }, item.workItem.id);

                vscode.window.showInformationMessage(`Feature #${newFeature.id} created: ${title}`);
                backlogProvider.refreshImmediate();
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to create Feature: ${error.message}`);
            }
        })
    );

    // Create New User Story (from feature)
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.createUserStory', async (item) => {
            if (!item || !item.workItem) return;

            const title = await vscode.window.showInputBox({
                prompt: 'Enter User Story title',
                placeHolder: 'User Story title...'
            });

            if (!title) return;

            const customFieldValues = await promptRequiredCustomFields('User Story');
            if (customFieldValues === undefined) { return; }

            try {
                const newStory = await adoService.createWorkItem('User Story', {
                    'System.Title': title,
                    'System.AreaPath': item.workItem.fields['System.AreaPath'],
                    'System.IterationPath': item.workItem.fields['System.IterationPath'],
                    ...customFieldValues
                }, item.workItem.id);

                vscode.window.showInformationMessage(`User Story #${newStory.id} created: ${title}`);
                backlogProvider.refreshImmediate();
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to create User Story: ${error.message}`);
            }
        })
    );

    // Create New Bug (from feature)
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.createBug', async (item) => {
            if (!item || !item.workItem) return;

            const title = await vscode.window.showInputBox({
                prompt: 'Enter Bug title',
                placeHolder: 'Bug title...'
            });

            if (!title) return;

            const customFieldValues = await promptRequiredCustomFields('Bug');
            if (customFieldValues === undefined) { return; }

            try {
                const newBug = await adoService.createWorkItem('Bug', {
                    'System.Title': title,
                    'System.AreaPath': item.workItem.fields['System.AreaPath'],
                    'System.IterationPath': item.workItem.fields['System.IterationPath'],
                    ...customFieldValues
                }, item.workItem.id);

                vscode.window.showInformationMessage(`Bug #${newBug.id} created: ${title}`);
                backlogProvider.refreshImmediate();
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to create Bug: ${error.message}`);
            }
        })
    );

    // Manage Custom Fields
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.manageCustomFields', () => {
            const nonce = crypto.randomBytes(16).toString('base64');
            const panel = vscode.window.createWebviewPanel(
                'adoCustomFields',
                'ADO: Manage Custom Fields',
                vscode.ViewColumn.One,
                { enableScripts: true }
            );

            const config = vscode.workspace.getConfiguration('adoBacklog');
            const customFields: CustomFieldConfig[] = config.get<CustomFieldConfig[]>('customFields') || [];

            panel.webview.html = getManageCustomFieldsHtml(customFields, nonce);

            panel.webview.onDidReceiveMessage(
                async message => {
                    if (message.command === 'saveFields') {
                        await vscode.workspace.getConfiguration('adoBacklog').update(
                            'customFields',
                            message.fields,
                            vscode.ConfigurationTarget.Global
                        );
                        vscode.window.showInformationMessage('Custom fields saved.');
                        // Refresh the webview with updated data
                        const updated = vscode.workspace.getConfiguration('adoBacklog').get<CustomFieldConfig[]>('customFields') || [];
                        panel.webview.html = getManageCustomFieldsHtml(updated, crypto.randomBytes(16).toString('base64'));
                    } else if (message.command === 'importFromAdo') {
                        // Standard fields the extension already handles
                        const standardFields = new Set([
                            'System.Id', 'System.Title', 'System.State', 'System.Reason',
                            'System.WorkItemType', 'System.AreaPath', 'System.IterationPath',
                            'System.AssignedTo', 'System.Tags', 'System.Description',
                            'System.CreatedBy', 'System.CreatedDate', 'System.ChangedBy',
                            'System.ChangedDate', 'System.TeamProject', 'System.Rev',
                            'System.BoardColumn', 'System.BoardColumnDone',
                            'Microsoft.VSTS.Common.AcceptanceCriteria',
                            'Microsoft.VSTS.Common.StateChangeDate',
                            'Microsoft.VSTS.Common.ActivatedDate',
                            'Microsoft.VSTS.Common.ActivatedBy',
                            'Microsoft.VSTS.Common.ResolvedDate',
                            'Microsoft.VSTS.Common.ResolvedBy',
                            'Microsoft.VSTS.Common.ResolvedReason',
                            'Microsoft.VSTS.Common.ClosedDate',
                            'Microsoft.VSTS.Common.ClosedBy',
                            'Microsoft.VSTS.Common.Priority',
                            'Microsoft.VSTS.Common.ValueArea'
                        ]);
                        const wiTypes = ['Epic', 'Feature', 'User Story', 'Bug'];
                        const discovered: {referenceName: string; name: string; allowedValues: string[]; workItemTypes: string[]; alwaysRequired: boolean}[] = [];
                        const seen = new Map<string, typeof discovered[0]>();

                        for (const wit of wiTypes) {
                            try {
                                const fields = await adoService.getWorkItemTypeFields(wit);
                                for (const f of fields) {
                                    if (standardFields.has(f.referenceName)) { continue; }
                                    if (seen.has(f.referenceName)) {
                                        seen.get(f.referenceName)!.workItemTypes.push(wit);
                                        if (f.alwaysRequired) {
                                            seen.get(f.referenceName)!.alwaysRequired = true;
                                        }
                                    } else {
                                        const entry = {
                                            referenceName: f.referenceName,
                                            name: f.name,
                                            allowedValues: f.allowedValues,
                                            workItemTypes: [wit],
                                            alwaysRequired: f.alwaysRequired
                                        };
                                        seen.set(f.referenceName, entry);
                                        discovered.push(entry);
                                    }
                                }
                            } catch (err) {
                                // skip types that fail
                            }
                        }

                        panel.webview.postMessage({
                            command: 'importResults',
                            discovered: discovered
                        });
                    }
                },
                undefined,
                context.subscriptions
            );
        })
    );

    // Configure State Indicators
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.configureStateIndicators', () => {
            const nonce = crypto.randomBytes(16).toString('base64');
            const panel = vscode.window.createWebviewPanel(
                'adoStateIndicators',
                'ADO: Configure State Indicators',
                vscode.ViewColumn.One,
                { enableScripts: true }
            );

            const config = vscode.workspace.getConfiguration('adoBacklog');
            const indicators: {state: string, indicator: string}[] = config.get('stateIndicators') || [];

            panel.webview.html = getStateIndicatorsHtml(indicators, nonce);

            panel.webview.onDidReceiveMessage(
                async message => {
                    if (message.command === 'saveIndicators') {
                        await vscode.workspace.getConfiguration('adoBacklog').update(
                            'stateIndicators',
                            message.indicators,
                            vscode.ConfigurationTarget.Global
                        );
                        vscode.window.showInformationMessage('State indicators saved.');
                        backlogProvider.refreshImmediate();
                    }
                },
                undefined,
                context.subscriptions
            );
        })
    );

    // Open work item in Azure DevOps browser
    context.subscriptions.push(
        vscode.commands.registerCommand('adoBacklog.openInBrowser', async (item) => {
            if (item && item.workItem) {
                const config = vscode.workspace.getConfiguration('adoBacklog');
                const orgUrl = config.get<string>('organizationUrl');
                const project = config.get<string>('project');
                if (orgUrl && project) {
                    const workItemUrl = `${orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${item.workItem.id}`;
                    vscode.env.openExternal(vscode.Uri.parse(workItemUrl));
                }
            }
        })
    );
}

async function promptRequiredCustomFields(workItemType: string): Promise<{ [key: string]: string } | undefined> {
    const customFields = getCustomFieldsForType(workItemType).filter(f => f.required);
    const result: { [key: string]: string } = {};

    for (const cf of customFields) {
        if (cf.type === 'dropdown' && cf.options && cf.options.length > 0) {
            const picked = await vscode.window.showQuickPick(cf.options, {
                placeHolder: `Select ${cf.label} (required)`,
                title: cf.label
            });
            if (picked === undefined) { return undefined; }
            result[cf.fieldReferenceName] = picked;
        } else {
            const value = await vscode.window.showInputBox({
                prompt: `Enter ${cf.label} (required)`,
                placeHolder: cf.label
            });
            if (value === undefined) { return undefined; }
            result[cf.fieldReferenceName] = value;
        }
    }

    return result;
}

function getWorkItemHtml(workItem: any, nonce: string, members: {displayName: string, uniqueName: string, id: string}[] = []): string {
    const fields = workItem.fields;
    const tags = fields['System.Tags'] ? fields['System.Tags'].split('; ').filter((t: string) => t.trim()) : [];
    const currentState = fields['System.State'] || '';
    const wiType = (fields['System.WorkItemType'] || '').toLowerCase().replace(/\s+/g, '-');

    // Build custom fields HTML for this work item type
    const workItemType = fields['System.WorkItemType'] || '';
    const customFields = getCustomFieldsForType(workItemType);
    let customFieldsHtml = '';
    if (customFields.length > 0) {
        customFieldsHtml = `<div class="wi-fields-group" style="margin-top: 0;">`;
        for (const cf of customFields) {
            const cfValue = fields[cf.fieldReferenceName] || '';
            const reqIndicator = cf.required ? ' <span style="color:#cc293d;">*</span>' : '';
            if (cf.type === 'dropdown' && cf.options && cf.options.length > 0) {
                const optionsHtml = cf.options.map(opt =>
                    `<option value="${escapeHtml(opt)}"${opt === cfValue ? ' selected' : ''}>${escapeHtml(opt)}</option>`
                ).join('');
                customFieldsHtml += `<div class="field">
                    <label>${escapeHtml(cf.label)}${reqIndicator}</label>
                    <select class="custom-field" data-field="${escapeHtml(cf.fieldReferenceName)}">
                        <option value="">-- Select --</option>
                        ${optionsHtml}
                    </select>
                </div>`;
            } else {
                customFieldsHtml += `<div class="field">
                    <label>${escapeHtml(cf.label)}${reqIndicator}</label>
                    <input type="text" class="custom-field" data-field="${escapeHtml(cf.fieldReferenceName)}" value="${escapeHtml(cfValue)}" />
                </div>`;
            }
        }
        customFieldsHtml += `</div>`;
    }

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <style>
            *, *::before, *::after { box-sizing: border-box; }
            body {
                font-family: var(--vscode-font-family);
                padding: 24px 32px;
                max-width: 960px;
                margin: 0 auto;
                color: var(--vscode-foreground);
            }
            label {
                display: block;
                font-weight: 600;
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.3px;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 6px;
            }
            input, textarea, select {
                width: 100%;
                padding: 7px 10px;
                margin-bottom: 0;
                border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.35));
                border-radius: 3px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                font-family: inherit;
                font-size: 13px;
                line-height: 1.4;
            }
            input:focus, textarea:focus, select:focus {
                outline: none;
                border-color: var(--vscode-focusBorder);
            }
            select { cursor: pointer; }
            textarea { min-height: 180px; }
            button {
                padding: 7px 18px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
            }
            button:hover { background: var(--vscode-button-hoverBackground); }
            .field { margin-bottom: 0; }
            /* tag bubble styles */
            .tag-container {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 5px;
                padding: 4px 8px;
                min-height: 35px;
                background: var(--vscode-input-background);
                border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.35));
                border-radius: 3px;
            }
            .tag-bubble {
                display: inline-flex;
                align-items: center;
                padding: 2px 8px;
                background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                border-radius: 10px;
                font-size: 12px;
                line-height: 1.4;
                white-space: nowrap;
            }
            .tag-bubble:hover { opacity: 0.85; }
            .tag-bubble .remove {
                margin-left: 5px;
                cursor: pointer;
                font-weight: bold;
                font-size: 13px;
                line-height: 1;
            }
            .tag-input-container {
                display: flex;
                align-items: center;
                gap: 4px;
                flex-basis: 100%;
                min-width: 0;
            }
            .tag-input-container input {
                flex: 1;
                border: none;
                background: transparent;
                padding: 3px 4px;
                font-size: 13px;
                min-width: 80px;
                outline: none;
            }
            .tag-input-container input:focus { border: none; box-shadow: none; }
            .tag-input-container button {
                padding: 3px 10px;
                font-size: 11px;
                white-space: nowrap;
                flex-shrink: 0;
            }
            /* HTML content rendering */
            .html-content {
                padding: 12px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.5));
                border-radius: 4px;
                overflow-y: auto;
                line-height: 1.6;
            }
            .html-content a {
                color: var(--vscode-textLink-foreground);
                text-decoration: none;
            }
            .html-content a:hover { text-decoration: underline; }
            .html-content ul, .html-content ol { margin-left: 20px; }
            .html-content b, .html-content strong { font-weight: bold; }
            .edit-toggle {
                display: inline-block;
                margin-left: 8px;
                cursor: pointer;
                color: var(--vscode-textLink-foreground);
                font-size: 12px;
                font-weight: 400;
                text-transform: none;
                letter-spacing: 0;
            }
            .edit-toggle:hover { text-decoration: underline; }
            /* Rich text editor */
            .editor-toolbar {
                display: none;
                flex-wrap: wrap;
                align-items: center;
                gap: 4px;
                padding: 6px 8px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-input-border);
                border-bottom: none;
                border-radius: 4px 4px 0 0;
            }
            .field-container { margin-bottom: 20px; }
            .field-container.edit-mode .editor-toolbar { display: flex; }
            .toolbar-divider {
                width: 1px;
                height: 22px;
                background: var(--vscode-input-border);
                margin: 0 4px;
                flex-shrink: 0;
            }
            .toolbar-button {
                padding: 3px 6px;
                background: var(--vscode-button-background);
                border: none;
                cursor: pointer;
                color: var(--vscode-button-foreground);
                min-width: 28px;
                font-size: 12px;
                border-radius: 3px;
                line-height: 1.4;
                text-align: center;
            }
            .toolbar-button:hover { background: var(--vscode-button-hoverBackground); }
            .toolbar-button:active { opacity: 0.8; }
            .toolbar-button.active {
                outline: 2px solid var(--vscode-focusBorder);
                outline-offset: -2px;
                background: var(--vscode-button-hoverBackground);
            }
            .toolbar-select {
                padding: 3px 4px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 3px;
                font-size: 12px;
                cursor: pointer;
            }
            .toolbar-color-wrap {
                position: relative;
                display: inline-flex;
                align-items: center;
            }
            .toolbar-color-wrap .toolbar-button { position: relative; }
            .toolbar-color-wrap .color-indicator {
                display: block;
                height: 3px;
                width: 100%;
                position: absolute;
                bottom: 2px;
                left: 0;
                border-radius: 1px;
            }
            .toolbar-color-wrap input[type="color"] {
                position: absolute;
                width: 0;
                height: 0;
                opacity: 0;
                padding: 0;
                margin: 0;
                border: none;
                pointer-events: none;
            }
            .rich-editor {
                min-height: 180px;
                border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.5));
                border-radius: 0 0 4px 4px;
                max-height: 500px;
                overflow-y: auto;
                padding: 12px 16px;
                display: none;
                background: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                line-height: 1.6;
            }
            .field-container.edit-mode .rich-editor { display: block; }
            .field-container.edit-mode .html-content { display: none; }
            .field-container.view-mode .rich-editor { display: none; }
            .field-container.view-mode .html-content { display: block; }
            .rich-editor ul, .rich-editor ol { margin-left: 20px; }
            .rich-editor blockquote {
                border-left: 3px solid var(--vscode-textLink-foreground);
                padding-left: 12px;
                margin: 8px 0;
                color: var(--vscode-descriptionForeground);
            }
            .rich-editor pre {
                background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
                padding: 10px 12px;
                border-radius: 4px;
                overflow-x: auto;
                margin: 8px 0;
            }
            .rich-editor code {
                font-family: var(--vscode-editor-font-family, monospace);
                font-size: 0.9em;
            }
            .rich-editor pre code {
                background: none;
                padding: 0;
            }
            .rich-editor hr {
                border: none;
                border-top: 1px solid var(--vscode-input-border);
                margin: 12px 0;
            }
            .rich-editor table {
                border-collapse: collapse;
                width: 100%;
                margin: 8px 0;
            }
            .rich-editor table td, .rich-editor table th {
                border: 1px solid var(--vscode-input-border);
                padding: 6px 10px;
                min-width: 40px;
            }
            .rich-editor table th {
                background: var(--vscode-input-background);
                font-weight: bold;
            }
            .rich-editor a {
                color: var(--vscode-textLink-foreground);
            }
            .html-content blockquote {
                border-left: 3px solid var(--vscode-textLink-foreground);
                padding-left: 12px;
                margin: 8px 0;
                color: var(--vscode-descriptionForeground);
            }
            .html-content pre {
                background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
                padding: 10px 12px;
                border-radius: 4px;
                overflow-x: auto;
                margin: 8px 0;
            }
            .html-content code {
                font-family: var(--vscode-editor-font-family, monospace);
                font-size: 0.9em;
            }
            .html-content pre code {
                background: none;
                padding: 0;
            }
            .html-content table {
                border-collapse: collapse;
                margin: 8px 0;
            }
            .html-content table td, .html-content table th {
                border: 1px solid var(--vscode-input-border);
                padding: 6px 10px;
            }
            /* Autocomplete dropdown */
            .autocomplete-wrapper { position: relative; }
            .autocomplete-wrapper input { margin-bottom: 0; }
            .autocomplete-dropdown {
                display: none;
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                max-height: 180px;
                overflow-y: auto;
                background: var(--vscode-dropdown-background, var(--vscode-input-background));
                border: 1px solid var(--vscode-input-border);
                border-top: none;
                z-index: 100;
                margin-bottom: 16px;
            }
            .autocomplete-dropdown .ac-item {
                padding: 6px 10px;
                cursor: pointer;
                display: flex;
                justify-content: space-between;
                font-size: 13px;
            }
            .autocomplete-dropdown .ac-item:hover,
            .autocomplete-dropdown .ac-item.active {
                background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
                color: var(--vscode-list-activeSelectionForeground, inherit);
            }
            .autocomplete-dropdown .ac-name { font-weight: 500; }
            .autocomplete-dropdown .ac-email {
                color: var(--vscode-descriptionForeground);
                font-size: 12px;
                margin-left: 8px;
                flex-shrink: 0;
            }
            /* ADO-style layout */
            .wi-header {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 20px;
                padding-bottom: 16px;
                border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.2));
            }
            .wi-type-badge {
                padding: 4px 10px;
                border-radius: 3px;
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                white-space: nowrap;
                background: var(--vscode-badge-background);
                color: #fff;
            }
            .wi-type-badge.type-epic { background: #e97e00; }
            .wi-type-badge.type-feature { background: #773b93; }
            .wi-type-badge.type-user-story { background: #009ccc; }
            .wi-type-badge.type-bug { background: #cc293d; }
            .wi-type-badge.type-task { background: #f2cb1d; color: #333; }
            .wi-id {
                color: var(--vscode-descriptionForeground);
                font-size: 14px;
                white-space: nowrap;
                font-weight: 500;
            }
            .wi-title-input {
                flex: 1;
                font-size: 20px;
                font-weight: 600;
                padding: 4px 8px;
                border: 1px solid transparent;
                border-radius: 3px;
                background: transparent;
                color: var(--vscode-foreground);
            }
            .wi-title-input:hover {
                border-color: var(--vscode-input-border, rgba(127,127,127,0.35));
            }
            .wi-title-input:focus {
                border-color: var(--vscode-focusBorder);
                background: var(--vscode-input-background);
                outline: none;
            }
            .wi-row {
                display: flex;
                gap: 20px;
                margin-bottom: 20px;
            }
            .wi-row > .field { flex: 1; min-width: 0; }
            .wi-fields-group {
                display: grid;
                grid-template-columns: 1fr 1fr 1fr;
                gap: 16px;
                margin-bottom: 24px;
                padding: 14px 16px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.35));
                border-radius: 4px;
            }
            .wi-fields-group .field { margin-bottom: 0; }
            .wi-header-actions {
                display: flex;
                align-items: center;
                gap: 4px;
                margin-left: auto;
                flex-shrink: 0;
            }
            .wi-icon-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 30px;
                height: 30px;
                padding: 0;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                color: #fff;
            }
            .wi-icon-btn:hover { opacity: 0.85; }
            .wi-icon-btn.btn-save { background: #0078d4; }
            .wi-icon-btn.btn-delete { background: #cc293d; }
            .wi-icon-btn svg { width: 16px; height: 16px; fill: #fff; }
            .wi-section-label {
                font-size: 13px;
                font-weight: 600;
                color: var(--vscode-foreground);
                text-transform: none;
                letter-spacing: 0;
                margin-bottom: 8px;
            }
        </style>
    </head>
    <body>
        <div class="wi-header">
            <span class="wi-type-badge type-${wiType}">${escapeHtml(fields['System.WorkItemType'] || '')}</span>
            <span class="wi-id">#${workItem.id}</span>
            <input type="text" id="title" class="wi-title-input" value="${escapeHtml(fields['System.Title'] || '')}" />
            <div class="wi-header-actions">
                <button id="saveBtn" class="wi-icon-btn btn-save" title="Save"><svg viewBox="0 0 16 16"><path d="M13.354 1h-1.354v4h-7v-4h-2v5.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-1.793l1.146-1.146a.5.5 0 0 0 .146-.354v-1.207a1 1 0 0 0-.293-.707l-1.293-1.293zm-4.354 0h-2v3h2v-3zm2.5 8h-7a.5.5 0 0 0-.5.5v5.5h8v-5.5a.5.5 0 0 0-.5-.5zm-1.5 4h-4v-3h4v3zm4-6.5v8.5h-12v-14h8.5l3.5 3.5v2zm-1-1.793l-1.707-1.707h-.293v0h-7v12h10v-7.586l-.707-.707h-.293z" fill-rule="evenodd" clip-rule="evenodd"/></svg></button>
                <button id="deleteBtn" class="wi-icon-btn btn-delete" title="Delete"><svg viewBox="0 0 16 16"><path d="M10 3h3v1h-1v9.5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5v-9.5h-1v-1h3v-1.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5zm-4 1v9.5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5v-9.5h-6zm1-1h4v-1h-4v1zm0 3h1v6h-1v-6zm2 0h1v6h-1v-6z"/></svg></button>
            </div>
        </div>

        <div class="wi-row">
            <div class="field">
                <label>Assigned To</label>
                <div class="autocomplete-wrapper">
                    <input type="text" id="assignedTo" autocomplete="off" value="${escapeHtml(fields['System.AssignedTo']?.displayName || fields['System.AssignedTo'] || '')}" />
                    <div class="autocomplete-dropdown" id="assignedToDropdown"></div>
                </div>
            </div>
            <div class="field">
                <label>Tags</label>
                <div class="tag-container" id="tagsContainer"></div>
            </div>
        </div>

        <div class="wi-fields-group">
            <div class="field">
                <label>State</label>
                <select id="state">
                    <option value="${escapeHtml(currentState)}" selected>${escapeHtml(currentState)}</option>
                </select>
            </div>
            <div class="field">
                <label>Area Path</label>
                <input type="text" value="${escapeHtml(fields['System.AreaPath'] || '')}" disabled />
            </div>
            <div class="field">
                <label>Iteration Path</label>
                <input type="text" id="iterationPath" value="${escapeHtml(fields['System.IterationPath'] || '')}" />
            </div>${workItemType === 'User Story' ? `
            <div class="field">
                <label>Story Points</label>
                <input type="number" id="storyPoints" value="${fields['Microsoft.VSTS.Scheduling.StoryPoints'] ?? ''}" min="0" step="0.5" />
            </div>` : ''}
        </div>

        ${customFieldsHtml}

        <div class="field-container view-mode" id="descriptionContainer">
            <label class="wi-section-label">
                Description
                <span class="edit-toggle" id="descriptionToggle"> &#9998; Edit</span>
            </label>
            <div class="html-content" id="descriptionView"></div>
            <div class="editor-toolbar" id="descriptionToolbar"></div>
            <div class="rich-editor" id="descriptionEditor" contenteditable="true"></div>
        </div>

        <div class="field-container view-mode" id="acceptanceCriteriaContainer">
            <label class="wi-section-label">
                Acceptance Criteria
                <span class="edit-toggle" id="acceptanceCriteriaToggle"> &#9998; Edit</span>
            </label>
            <div class="html-content" id="acceptanceCriteriaView"></div>
            <div class="editor-toolbar" id="acceptanceCriteriaToolbar"></div>
            <div class="rich-editor" id="acceptanceCriteriaEditor" contenteditable="true"></div>
        </div>

        <div id="modalOverlay" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center;">
            <div style="background:var(--vscode-editor-background); border:1px solid var(--vscode-input-border); border-radius:6px; padding:20px; min-width:300px; max-width:400px;">
                <div id="modalTitle" style="font-weight:bold; margin-bottom:12px;"></div>
                <div id="modalBody"></div>
                <div style="display:flex; gap:8px; margin-top:16px; justify-content:flex-end;">
                    <button id="modalCancel" style="padding:6px 14px; background:var(--vscode-button-secondaryBackground, #333); color:var(--vscode-button-secondaryForeground, #fff); border:none; cursor:pointer; border-radius:3px;">Cancel</button>
                    <button id="modalOk" style="padding:6px 14px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; cursor:pointer; border-radius:3px;">OK</button>
                </div>
            </div>
        </div>

        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            let currentTags = ${JSON.stringify(tags)};

            // --- Assigned To autocomplete ---
            (function() {
                const members = ${JSON.stringify(members)};
                const input = document.getElementById('assignedTo');
                const dropdown = document.getElementById('assignedToDropdown');
                let activeIdx = -1;

                function render(filtered) {
                    dropdown.innerHTML = '';
                    activeIdx = -1;
                    if (filtered.length === 0) { dropdown.style.display = 'none'; return; }
                    filtered.forEach((m, i) => {
                        const div = document.createElement('div');
                        div.className = 'ac-item';
                        const name = document.createElement('span');
                        name.className = 'ac-name';
                        name.textContent = m.displayName;
                        const email = document.createElement('span');
                        email.className = 'ac-email';
                        email.textContent = m.uniqueName;
                        div.appendChild(name);
                        div.appendChild(email);
                        div.addEventListener('mousedown', (e) => {
                            e.preventDefault();
                            input.value = m.uniqueName;
                            dropdown.style.display = 'none';
                        });
                        dropdown.appendChild(div);
                    });
                    dropdown.style.display = 'block';
                }

                function filter() {
                    const val = input.value.toLowerCase();
                    if (!val) { dropdown.style.display = 'none'; return; }
                    const filtered = members.filter(m =>
                        m.displayName.toLowerCase().includes(val) ||
                        m.uniqueName.toLowerCase().includes(val)
                    ).slice(0, 8);
                    render(filtered);
                }

                input.addEventListener('input', filter);
                input.addEventListener('focus', () => { if (input.value) filter(); });
                input.addEventListener('blur', () => { dropdown.style.display = 'none'; });
                input.addEventListener('keydown', (e) => {
                    const items = dropdown.querySelectorAll('.ac-item');
                    if (!items.length || dropdown.style.display === 'none') return;
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        activeIdx = Math.min(activeIdx + 1, items.length - 1);
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        activeIdx = Math.max(activeIdx - 1, 0);
                    } else if (e.key === 'Enter' && activeIdx >= 0) {
                        e.preventDefault();
                        items[activeIdx].dispatchEvent(new MouseEvent('mousedown'));
                        return;
                    } else if (e.key === 'Escape') {
                        dropdown.style.display = 'none';
                        return;
                    } else { return; }
                    items.forEach(it => it.classList.remove('active'));
                    items[activeIdx].classList.add('active');
                    items[activeIdx].scrollIntoView({ block: 'nearest' });
                });
            })();

            // --- HTML Sanitizer ---
            function sanitizeHtml(html) {
                if (!html) return '';
                const temp = document.createElement('div');
                temp.innerHTML = html;
                const dangerousTags = ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'LINK', 'META'];
                temp.querySelectorAll(dangerousTags.join(',')).forEach(el => el.remove());
                // Remove event handler attributes and javascript: URLs from all elements
                const allElements = temp.querySelectorAll('*');
                for (const el of allElements) {
                    const attrs = Array.from(el.attributes);
                    for (const attr of attrs) {
                        if (attr.name.startsWith('on')) {
                            el.removeAttribute(attr.name);
                        }
                        if ((attr.name === 'href' || attr.name === 'src' || attr.name === 'action') &&
                            attr.value.trim().toLowerCase().startsWith('javascript:')) {
                            el.removeAttribute(attr.name);
                        }
                    }
                }
                return temp.innerHTML;
            }

            // --- Initialize rich content fields with sanitization ---
            const rawDescription = ${JSON.stringify(fields['System.Description'] || '')};
            const rawAcceptanceCriteria = ${JSON.stringify(fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '')};

            document.getElementById('descriptionView').innerHTML = sanitizeHtml(rawDescription);
            document.getElementById('descriptionEditor').innerHTML = sanitizeHtml(rawDescription);
            document.getElementById('acceptanceCriteriaView').innerHTML = sanitizeHtml(rawAcceptanceCriteria);
            document.getElementById('acceptanceCriteriaEditor').innerHTML = sanitizeHtml(rawAcceptanceCriteria);

            // --- Modal dialog helper (prompt() not available in webviews) ---
            function showModal(title, fields) {
                return new Promise((resolve) => {
                    const overlay = document.getElementById('modalOverlay');
                    const titleEl = document.getElementById('modalTitle');
                    const body = document.getElementById('modalBody');
                    titleEl.textContent = title;
                    body.innerHTML = '';
                    const inputs = [];
                    fields.forEach(f => {
                        const label = document.createElement('label');
                        label.textContent = f.label;
                        label.style.display = 'block';
                        label.style.marginBottom = '4px';
                        label.style.marginTop = inputs.length ? '10px' : '0';
                        body.appendChild(label);
                        const input = document.createElement('input');
                        input.type = f.type || 'text';
                        input.value = f.defaultValue || '';
                        input.placeholder = f.placeholder || '';
                        input.style.cssText = 'width:100%;padding:6px 8px;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;';
                        body.appendChild(input);
                        inputs.push({ key: f.key, input: input });
                    });
                    overlay.style.display = 'flex';
                    if (inputs.length > 0) inputs[0].input.focus();

                    function cleanup() {
                        overlay.style.display = 'none';
                        document.getElementById('modalOk').replaceWith(document.getElementById('modalOk').cloneNode(true));
                        document.getElementById('modalCancel').replaceWith(document.getElementById('modalCancel').cloneNode(true));
                    }
                    document.getElementById('modalOk').addEventListener('click', () => {
                        const result = {};
                        inputs.forEach(i => { result[i.key] = i.input.value; });
                        cleanup();
                        resolve(result);
                    });
                    document.getElementById('modalCancel').addEventListener('click', () => {
                        cleanup();
                        resolve(null);
                    });
                    // Allow Enter to submit
                    inputs.forEach(i => {
                        i.input.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter') document.getElementById('modalOk').click();
                            if (e.key === 'Escape') document.getElementById('modalCancel').click();
                        });
                    });
                });
            }

            // --- Selection save/restore (for async modal dialogs) ---
            function saveSelection() {
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0) {
                    return sel.getRangeAt(0).cloneRange();
                }
                return null;
            }
            function restoreSelection(range) {
                if (range) {
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }

            // --- Build toolbar buttons via DOM ---
            function buildToolbar(toolbarId, fieldName) {
                const toolbar = document.getElementById(toolbarId);

                function addDivider() {
                    const d = document.createElement('span');
                    d.className = 'toolbar-divider';
                    toolbar.appendChild(d);
                }

                function addButton(cmd, label, title, action) {
                    const btn = document.createElement('button');
                    btn.className = 'toolbar-button';
                    btn.innerHTML = label;
                    btn.title = title;
                    if (cmd) btn.dataset.command = cmd;
                    btn.addEventListener('click', () => {
                        const editor = document.getElementById(fieldName + 'Editor');
                        editor.focus();
                        if (action) {
                            action(editor);
                        } else {
                            document.execCommand(cmd, false, null);
                        }
                        updateActiveStates(toolbar);
                    });
                    toolbar.appendChild(btn);
                    return btn;
                }

                // --- Group: Text style ---
                addButton('bold', '<b>B</b>', 'Bold');
                addButton('italic', '<i>I</i>', 'Italic');
                addButton('underline', '<u>U</u>', 'Underline');
                addButton('strikethrough', '<s>S</s>', 'Strikethrough');
                addButton('removeFormat', '\\u2717', 'Remove Formatting');

                addDivider();

                // --- Group: Headings ---
                addButton(null, 'H1', 'Heading 1', () => document.execCommand('formatBlock', false, 'h1'));
                addButton(null, 'H2', 'Heading 2', () => document.execCommand('formatBlock', false, 'h2'));
                addButton(null, 'H3', 'Heading 3', () => document.execCommand('formatBlock', false, 'h3'));
                addButton(null, 'P', 'Paragraph', () => document.execCommand('formatBlock', false, 'p'));
                addButton(null, '\\u275D', 'Blockquote', () => document.execCommand('formatBlock', false, 'blockquote'));

                addDivider();

                // --- Group: Lists & indent ---
                addButton('insertOrderedList', '1.', 'Numbered List');
                addButton('insertUnorderedList', '\\u2022', 'Bulleted List');
                addButton('indent', '\\u2192', 'Indent');
                addButton('outdent', '\\u2190', 'Outdent');

                addDivider();

                // --- Group: Links & media ---
                addButton(null, '\\uD83D\\uDD17', 'Insert Link', async (editor) => {
                    const savedSel = saveSelection();
                    const result = await showModal('Insert Link', [
                        { key: 'url', label: 'URL', defaultValue: 'https://', placeholder: 'https://example.com' }
                    ]);
                    if (result && result.url) {
                        editor.focus();
                        restoreSelection(savedSel);
                        document.execCommand('createLink', false, result.url);
                    }
                });
                addButton('unlink', '\\u26D3', 'Remove Link');
                addButton('insertHorizontalRule', '\\u2015', 'Horizontal Rule');
                addButton(null, '&lt;/&gt;', 'Code Block', (editor) => {
                    const selection = window.getSelection();
                    if (selection && selection.rangeCount > 0) {
                        const range = selection.getRangeAt(0);
                        const selectedText = range.toString();
                        const pre = document.createElement('pre');
                        const code = document.createElement('code');
                        code.textContent = selectedText || 'code here';
                        pre.appendChild(code);
                        range.deleteContents();
                        range.insertNode(pre);
                        selection.collapseToEnd();
                    }
                });

                addDivider();

                // --- Group: Font size ---
                const sizeSelect = document.createElement('select');
                sizeSelect.className = 'toolbar-select';
                sizeSelect.title = 'Font Size';
                [
                    { value: '', label: 'Size' },
                    { value: '2', label: 'Small' },
                    { value: '3', label: 'Normal' },
                    { value: '5', label: 'Large' }
                ].forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt.value;
                    o.textContent = opt.label;
                    sizeSelect.appendChild(o);
                });
                sizeSelect.addEventListener('change', () => {
                    if (sizeSelect.value) {
                        const editor = document.getElementById(fieldName + 'Editor');
                        editor.focus();
                        document.execCommand('fontSize', false, sizeSelect.value);
                    }
                    sizeSelect.value = '';
                });
                toolbar.appendChild(sizeSelect);

                // --- Helper: wrap selection with inline style (ADO-compatible) ---
                function applyInlineStyle(prop, value) {
                    const sel = window.getSelection();
                    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
                    const range = sel.getRangeAt(0);
                    const span = document.createElement('span');
                    span.style[prop] = value;
                    range.surroundContents(span);
                    sel.collapseToEnd();
                }

                // --- Group: Colors (inline with buttons) ---
                function addColorButton(label, title, defaultColor, cssProp) {
                    const wrap = document.createElement('span');
                    wrap.className = 'toolbar-color-wrap';
                    const btn = document.createElement('button');
                    btn.className = 'toolbar-button';
                    btn.title = title;
                    btn.innerHTML = label;
                    const indicator = document.createElement('span');
                    indicator.className = 'color-indicator';
                    indicator.style.background = defaultColor;
                    btn.appendChild(indicator);
                    btn.style.position = 'relative';
                    const picker = document.createElement('input');
                    picker.type = 'color';
                    picker.value = defaultColor;
                    wrap.appendChild(btn);
                    wrap.appendChild(picker);
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        // Save selection before picker opens
                        wrap._savedSel = saveSelection();
                        picker.click();
                    });
                    picker.addEventListener('input', () => {
                        indicator.style.background = picker.value;
                        const editor = document.getElementById(fieldName + 'Editor');
                        editor.focus();
                        restoreSelection(wrap._savedSel);
                        applyInlineStyle(cssProp, picker.value);
                    });
                    toolbar.appendChild(wrap);
                }

                addColorButton('<b>A</b>', 'Text Color', '#ffffff', 'color');
                addColorButton('\\uD83D\\uDD8D', 'Highlight', '#ffff00', 'backgroundColor');

                // --- Table, Undo, Redo (inline) ---
                addButton(null, '\\u25A6', 'Insert Table', async (editor) => {
                    const savedSel = saveSelection();
                    const result = await showModal('Insert Table', [
                        { key: 'rows', label: 'Rows', defaultValue: '3', type: 'number' },
                        { key: 'cols', label: 'Columns', defaultValue: '3', type: 'number' }
                    ]);
                    if (result && result.rows && result.cols) {
                        const r = parseInt(result.rows, 10);
                        const c = parseInt(result.cols, 10);
                        if (r > 0 && c > 0 && r <= 20 && c <= 20) {
                            let html = '<table>';
                            for (let i = 0; i < r; i++) {
                                html += '<tr>';
                                for (let j = 0; j < c; j++) {
                                    const tag = i === 0 ? 'th' : 'td';
                                    html += '<' + tag + '>\\u00A0</' + tag + '>';
                                }
                                html += '</tr>';
                            }
                            html += '</table>';
                            editor.focus();
                            restoreSelection(savedSel);
                            document.execCommand('insertHTML', false, html);
                        }
                    }
                });
                addButton('undo', '\\u21A9', 'Undo');
                addButton('redo', '\\u21AA', 'Redo');
            }

            // --- Active state tracking ---
            function updateActiveStates(toolbar) {
                const toggleCommands = ['bold', 'italic', 'underline', 'strikethrough',
                                        'insertOrderedList', 'insertUnorderedList'];
                toolbar.querySelectorAll('.toolbar-button').forEach(btn => {
                    const cmd = btn.dataset.command;
                    if (cmd && toggleCommands.includes(cmd)) {
                        try {
                            if (document.queryCommandState(cmd)) {
                                btn.classList.add('active');
                            } else {
                                btn.classList.remove('active');
                            }
                        } catch(e) {}
                    }
                });
            }

            document.addEventListener('selectionchange', () => {
                ['descriptionToolbar', 'acceptanceCriteriaToolbar'].forEach(id => {
                    const tb = document.getElementById(id);
                    if (tb) updateActiveStates(tb);
                });
            });

            buildToolbar('descriptionToolbar', 'description');
            buildToolbar('acceptanceCriteriaToolbar', 'acceptanceCriteria');

            // --- Request available states ---
            vscode.postMessage({
                command: 'getStates',
                workItemType: ${JSON.stringify(fields['System.WorkItemType'] || '')},
                currentState: ${JSON.stringify(currentState)}
            });

            window.addEventListener('message', event => {
                const message = event.data;
                if (message.command === 'updateStates') {
                    updateStateDropdown(message.states, message.currentState);
                }
            });

            function updateStateDropdown(states, currentState) {
                const select = document.getElementById('state');
                select.innerHTML = '';
                states.forEach(state => {
                    const option = document.createElement('option');
                    option.value = state;
                    option.textContent = state;
                    if (state === currentState) option.selected = true;
                    select.appendChild(option);
                });
            }

            // --- Toggle edit/view for rich text fields ---
            function setupToggle(fieldName, toggleId) {
                const toggle = document.getElementById(toggleId);
                toggle.addEventListener('click', function() {
                    const container = document.getElementById(fieldName + 'Container');
                    const editor = document.getElementById(fieldName + 'Editor');
                    const view = document.getElementById(fieldName + 'View');

                    if (container.classList.contains('edit-mode')) {
                        container.classList.remove('edit-mode');
                        container.classList.add('view-mode');
                        view.innerHTML = sanitizeHtml(editor.innerHTML);
                        toggle.textContent = ' \\u270E Edit';
                    } else {
                        const viewContent = view.innerHTML;
                        if (viewContent.includes('<em>No') || viewContent.includes('description</em>') || viewContent.includes('<em>No acceptance criteria</em>')) {
                            editor.innerHTML = '';
                        } else {
                            editor.innerHTML = sanitizeHtml(viewContent);
                        }
                        container.classList.remove('view-mode');
                        container.classList.add('edit-mode');
                        toggle.textContent = '\\u270E View';
                        editor.focus();
                    }
                });
            }
            setupToggle('description', 'descriptionToggle');
            setupToggle('acceptanceCriteria', 'acceptanceCriteriaToggle');

            // --- Tag management using DOM APIs ---
            function renderTags() {
                const container = document.getElementById('tagsContainer');
                container.innerHTML = '';

                currentTags.forEach(tag => {
                    const bubble = document.createElement('span');
                    bubble.className = 'tag-bubble';
                    bubble.dataset.tag = tag;
                    bubble.appendChild(document.createTextNode(tag));

                    const remove = document.createElement('span');
                    remove.className = 'remove';
                    remove.textContent = '\\u00D7';
                    remove.addEventListener('click', () => {
                        currentTags = currentTags.filter(t => t !== tag);
                        renderTags();
                    });
                    bubble.appendChild(remove);
                    container.appendChild(bubble);
                });

                const inputContainer = document.createElement('div');
                inputContainer.className = 'tag-input-container';

                const input = document.createElement('input');
                input.type = 'text';
                input.id = 'newTag';
                input.placeholder = 'Add new tag...';
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') addTag();
                });
                inputContainer.appendChild(input);

                const addBtn = document.createElement('button');
                addBtn.textContent = 'Add Tag';
                addBtn.addEventListener('click', () => addTag());
                inputContainer.appendChild(addBtn);

                container.appendChild(inputContainer);
            }

            function addTag() {
                const input = document.getElementById('newTag');
                const tag = input.value.trim();
                if (tag && !currentTags.includes(tag)) {
                    currentTags.push(tag);
                    renderTags();
                }
                input.value = '';
            }

            renderTags();

            // --- Save / Delete ---
            document.getElementById('saveBtn').addEventListener('click', function() {
                const descriptionEditor = document.getElementById('descriptionEditor');
                const acceptanceCriteriaEditor = document.getElementById('acceptanceCriteriaEditor');

                const saveFields = {
                    'System.Title': document.getElementById('title').value,
                    'System.State': document.getElementById('state').value,
                    'System.IterationPath': document.getElementById('iterationPath').value,
                    'System.AssignedTo': document.getElementById('assignedTo').value,
                    'System.Tags': currentTags.join('; '),
                    'System.Description': descriptionEditor.innerHTML,
                    'Microsoft.VSTS.Common.AcceptanceCriteria': acceptanceCriteriaEditor.innerHTML
                };

                // Include story points if present
                const storyPointsEl = document.getElementById('storyPoints');
                if (storyPointsEl) {
                    const val = storyPointsEl.value;
                    saveFields['Microsoft.VSTS.Scheduling.StoryPoints'] = val === '' ? null : parseFloat(val);
                }

                // Include custom field values
                document.querySelectorAll('.custom-field').forEach(function(el) {
                    saveFields[el.dataset.field] = el.value;
                });

                vscode.postMessage({
                    command: 'save',
                    fields: saveFields
                });
            });

            document.getElementById('deleteBtn').addEventListener('click', function() {
                if (confirm('Are you sure you want to delete this work item?')) {
                    vscode.postMessage({ command: 'delete' });
                }
            });
        </script>
    </body>
    </html>`;
}

function getTeamInfoHtml(teamName: string, members: any[], _nonce: string): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
        <title>Team Information</title>
        <style>
            body {
                font-family: var(--vscode-font-family);
                padding: 20px;
                color: var(--vscode-foreground);
            }
            h2 {
                color: var(--vscode-foreground);
                border-bottom: 1px solid var(--vscode-panel-border);
                padding-bottom: 10px;
            }
            table {
                border-collapse: collapse;
                margin-top: 20px;
            }
            th, td {
                text-align: left;
                padding: 8px 16px;
                border-bottom: 1px solid var(--vscode-panel-border);
            }
            th {
                font-weight: bold;
                color: var(--vscode-foreground);
            }
            tr:hover {
                background: var(--vscode-list-hoverBackground);
            }
            .empty-state {
                text-align: center;
                padding: 40px;
                color: var(--vscode-descriptionForeground);
            }
            .member-count {
                color: var(--vscode-descriptionForeground);
                font-size: 14px;
                margin-top: 5px;
            }
        </style>
    </head>
    <body>
        <h2>${escapeHtml(teamName)}</h2>
        <div class="member-count">${members.length} member${members.length !== 1 ? 's' : ''}</div>
        ${members.length > 0 ? `
        <table>
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Unique Name</th>
                    <th>ID</th>
                </tr>
            </thead>
            <tbody>
                ${members.map(member => `
                    <tr>
                        <td>${escapeHtml(member.displayName)}</td>
                        <td>${escapeHtml(member.uniqueName)}</td>
                        <td><code>${escapeHtml(member.id)}</code></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>` : `
        <div class="empty-state">
            <p>No team members found.</p>
            <p>This might mean the area path doesn't match an Azure DevOps team name.</p>
        </div>`}
    </body>
    </html>`;
}

interface CustomFieldConfig {
    fieldReferenceName: string;
    label: string;
    type: 'string' | 'dropdown';
    options?: string[];
    required: boolean;
    workItemTypes: string[];
}

function getCustomFieldsForType(workItemType: string): CustomFieldConfig[] {
    const config = vscode.workspace.getConfiguration('adoBacklog');
    const customFields = config.get<CustomFieldConfig[]>('customFields') || [];
    return customFields.filter(f => f.workItemTypes.includes(workItemType));
}

function getManageCustomFieldsHtml(fields: CustomFieldConfig[], nonce: string): string {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <style>
            *, *::before, *::after { box-sizing: border-box; }
            body {
                font-family: var(--vscode-font-family);
                padding: 24px 32px;
                max-width: 960px;
                margin: 0 auto;
                color: var(--vscode-foreground);
            }
            h2 { margin-top: 0; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
            th, td {
                text-align: left;
                padding: 8px 10px;
                border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.2));
                font-size: 13px;
            }
            th {
                font-weight: 600;
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.3px;
                color: var(--vscode-descriptionForeground);
            }
            tr:hover { background: var(--vscode-list-hoverBackground); }
            button {
                padding: 6px 14px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-size: 13px;
            }
            button:hover { background: var(--vscode-button-hoverBackground); }
            button.danger { background: #cc293d; }
            button.danger:hover { opacity: 0.85; }
            button.secondary {
                background: var(--vscode-button-secondaryBackground, #333);
                color: var(--vscode-button-secondaryForeground, #fff);
            }
            .form-section {
                padding: 16px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.35));
                border-radius: 4px;
                margin-bottom: 16px;
                display: none;
            }
            .form-section.visible { display: block; }
            .form-row { margin-bottom: 12px; }
            .form-row label {
                display: block;
                font-weight: 600;
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.3px;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 4px;
            }
            .form-row input, .form-row select {
                width: 100%;
                padding: 6px 10px;
                border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.35));
                border-radius: 3px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                font-size: 13px;
            }
            .checkbox-group { display: flex; flex-wrap: wrap; gap: 12px; }
            .checkbox-group label {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-weight: normal;
                font-size: 13px;
                text-transform: none;
                letter-spacing: 0;
                color: var(--vscode-foreground);
            }
            .form-actions { display: flex; gap: 8px; margin-top: 16px; }
            .empty-state {
                text-align: center;
                padding: 24px;
                color: var(--vscode-descriptionForeground);
            }
            .btn-row { display: flex; gap: 8px; margin-bottom: 16px; }
            .import-section {
                padding: 16px;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.35));
                border-radius: 4px;
                margin-bottom: 16px;
                display: none;
            }
            .import-section.visible { display: block; }
            .import-item {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 6px 0;
                border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.2));
                font-size: 13px;
            }
            .import-item label {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                font-weight: normal;
                font-size: 13px;
                text-transform: none;
                letter-spacing: 0;
                color: var(--vscode-foreground);
                cursor: pointer;
                flex: 1;
            }
            .import-item .import-detail {
                color: var(--vscode-descriptionForeground);
                font-size: 12px;
            }
            .import-actions { display: flex; gap: 8px; margin-top: 12px; }
            .spinner { display: none; color: var(--vscode-descriptionForeground); font-size: 13px; padding: 8px 0; }
            .spinner.visible { display: block; }
        </style>
    </head>
    <body>
        <h2>Custom Fields</h2>
        <div id="tableContainer"></div>
        <div class="btn-row">
            <button id="addBtn">Add Field</button>
            <button id="importBtn" class="secondary">Import from ADO</button>
        </div>
        <div class="spinner" id="importSpinner">Loading fields from Azure DevOps...</div>
        <div class="import-section" id="importSection">
            <h3>Fields from Azure DevOps</h3>
            <p style="font-size:12px;color:var(--vscode-descriptionForeground);margin-top:0;">Select fields to import. Fields already configured are excluded.</p>
            <div id="importList"></div>
            <div class="import-actions">
                <button id="importSelectedBtn">Import Selected</button>
                <button id="importCancelBtn" class="secondary">Cancel</button>
            </div>
        </div>

        <div class="form-section" id="formSection">
            <h3 id="formTitle">Add Custom Field</h3>
            <input type="hidden" id="editIndex" value="-1" />
            <div class="form-row">
                <label>Field Reference Name</label>
                <input type="text" id="fieldRef" placeholder="e.g., Custom.MyField" />
            </div>
            <div class="form-row">
                <label>Display Label</label>
                <input type="text" id="fieldLabel" placeholder="e.g., My Field" />
            </div>
            <div class="form-row">
                <label>Type</label>
                <select id="fieldType">
                    <option value="string">String</option>
                    <option value="dropdown">Dropdown</option>
                </select>
            </div>
            <div class="form-row" id="optionsRow" style="display:none;">
                <label>Options (comma-separated)</label>
                <input type="text" id="fieldOptions" placeholder="e.g., Option1, Option2, Option3" />
            </div>
            <div class="form-row">
                <label>Required</label>
                <div class="checkbox-group">
                    <label><input type="checkbox" id="fieldRequired" /> Required during creation</label>
                </div>
            </div>
            <div class="form-row">
                <label>Work Item Types</label>
                <div class="checkbox-group">
                    <label><input type="checkbox" class="wiType" value="Epic" /> Epic</label>
                    <label><input type="checkbox" class="wiType" value="Feature" /> Feature</label>
                    <label><input type="checkbox" class="wiType" value="User Story" /> User Story</label>
                    <label><input type="checkbox" class="wiType" value="Bug" /> Bug</label>
                </div>
            </div>
            <div class="form-actions">
                <button id="saveFieldBtn">Save</button>
                <button id="cancelBtn" class="secondary">Cancel</button>
            </div>
        </div>

        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            let fields = ${JSON.stringify(fields)};

            function renderTable() {
                const container = document.getElementById('tableContainer');
                if (fields.length === 0) {
                    container.innerHTML = '<div class="empty-state">No custom fields configured. Click "Add Field" to get started.</div>';
                    return;
                }
                let html = '<table><thead><tr><th>Reference Name</th><th>Label</th><th>Type</th><th>Work Item Types</th><th>Required</th><th>Actions</th></tr></thead><tbody>';
                fields.forEach((f, i) => {
                    html += '<tr>'
                        + '<td>' + esc(f.fieldReferenceName) + '</td>'
                        + '<td>' + esc(f.label) + '</td>'
                        + '<td>' + esc(f.type) + '</td>'
                        + '<td>' + esc((f.workItemTypes || []).join(', ')) + '</td>'
                        + '<td>' + (f.required ? 'Yes' : 'No') + '</td>'
                        + '<td><button class="edit-btn" data-index="' + i + '">Edit</button> <button class="danger delete-btn" data-index="' + i + '">Delete</button></td>'
                        + '</tr>';
                });
                html += '</tbody></table>';
                container.innerHTML = html;

                container.querySelectorAll('.edit-btn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        editField(parseInt(btn.getAttribute('data-index'), 10));
                    });
                });
                container.querySelectorAll('.delete-btn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        deleteField(parseInt(btn.getAttribute('data-index'), 10));
                    });
                });
            }

            function esc(s) {
                const d = document.createElement('div');
                d.textContent = s || '';
                return d.innerHTML;
            }

            document.getElementById('addBtn').addEventListener('click', () => {
                resetForm();
                document.getElementById('formTitle').textContent = 'Add Custom Field';
                document.getElementById('editIndex').value = '-1';
                document.getElementById('formSection').classList.add('visible');
            });

            document.getElementById('cancelBtn').addEventListener('click', () => {
                document.getElementById('formSection').classList.remove('visible');
            });

            document.getElementById('fieldType').addEventListener('change', () => {
                document.getElementById('optionsRow').style.display =
                    document.getElementById('fieldType').value === 'dropdown' ? 'block' : 'none';
            });

            document.getElementById('saveFieldBtn').addEventListener('click', () => {
                const ref = document.getElementById('fieldRef').value.trim();
                const label = document.getElementById('fieldLabel').value.trim();
                const type = document.getElementById('fieldType').value;
                const optionsStr = document.getElementById('fieldOptions').value.trim();
                const required = document.getElementById('fieldRequired').checked;
                const wiTypes = Array.from(document.querySelectorAll('.wiType:checked')).map(cb => cb.value);

                if (!ref || !label || wiTypes.length === 0) {
                    return;
                }

                const entry = {
                    fieldReferenceName: ref,
                    label: label,
                    type: type,
                    required: required,
                    workItemTypes: wiTypes
                };
                if (type === 'dropdown' && optionsStr) {
                    entry.options = optionsStr.split(',').map(o => o.trim()).filter(o => o);
                }

                const idx = parseInt(document.getElementById('editIndex').value, 10);
                if (idx >= 0) {
                    fields[idx] = entry;
                } else {
                    fields.push(entry);
                }

                vscode.postMessage({ command: 'saveFields', fields: fields });
                document.getElementById('formSection').classList.remove('visible');
                renderTable();
            });

            function editField(i) {
                const f = fields[i];
                document.getElementById('fieldRef').value = f.fieldReferenceName || '';
                document.getElementById('fieldLabel').value = f.label || '';
                document.getElementById('fieldType').value = f.type || 'string';
                document.getElementById('fieldOptions').value = (f.options || []).join(', ');
                document.getElementById('fieldRequired').checked = !!f.required;
                document.querySelectorAll('.wiType').forEach(cb => {
                    cb.checked = (f.workItemTypes || []).includes(cb.value);
                });
                document.getElementById('optionsRow').style.display = f.type === 'dropdown' ? 'block' : 'none';
                document.getElementById('editIndex').value = String(i);
                document.getElementById('formTitle').textContent = 'Edit Custom Field';
                document.getElementById('formSection').classList.add('visible');
            }

            function deleteField(i) {
                fields.splice(i, 1);
                vscode.postMessage({ command: 'saveFields', fields: fields });
                renderTable();
            }

            function resetForm() {
                document.getElementById('fieldRef').value = '';
                document.getElementById('fieldLabel').value = '';
                document.getElementById('fieldType').value = 'string';
                document.getElementById('fieldOptions').value = '';
                document.getElementById('fieldRequired').checked = false;
                document.querySelectorAll('.wiType').forEach(cb => { cb.checked = false; });
                document.getElementById('optionsRow').style.display = 'none';
            }

            renderTable();

            // --- Import from ADO ---
            let discoveredFields = [];

            document.getElementById('importBtn').addEventListener('click', () => {
                document.getElementById('importSpinner').classList.add('visible');
                document.getElementById('importSection').classList.remove('visible');
                vscode.postMessage({ command: 'importFromAdo' });
            });

            document.getElementById('importCancelBtn').addEventListener('click', () => {
                document.getElementById('importSection').classList.remove('visible');
            });

            document.getElementById('importSelectedBtn').addEventListener('click', () => {
                const checkboxes = document.querySelectorAll('.import-cb:checked');
                checkboxes.forEach(function(cb) {
                    const idx = parseInt(cb.getAttribute('data-index'), 10);
                    const f = discoveredFields[idx];
                    if (!f) { return; }
                    const hasOptions = f.allowedValues && f.allowedValues.length > 0;
                    const entry = {
                        fieldReferenceName: f.referenceName,
                        label: f.name,
                        type: hasOptions ? 'dropdown' : 'string',
                        required: f.alwaysRequired,
                        workItemTypes: f.workItemTypes
                    };
                    if (hasOptions) {
                        entry.options = f.allowedValues;
                    }
                    fields.push(entry);
                });
                if (checkboxes.length > 0) {
                    vscode.postMessage({ command: 'saveFields', fields: fields });
                    renderTable();
                }
                document.getElementById('importSection').classList.remove('visible');
            });

            window.addEventListener('message', function(event) {
                const message = event.data;
                if (message.command === 'importResults') {
                    document.getElementById('importSpinner').classList.remove('visible');
                    discoveredFields = message.discovered;

                    // Filter out fields already configured
                    const existingRefs = new Set(fields.map(f => f.fieldReferenceName));
                    const available = discoveredFields.filter(f => !existingRefs.has(f.referenceName));

                    const list = document.getElementById('importList');
                    if (available.length === 0) {
                        list.innerHTML = '<div class="empty-state">No new fields found. All discovered fields are already configured.</div>';
                        document.getElementById('importSelectedBtn').style.display = 'none';
                    } else {
                        document.getElementById('importSelectedBtn').style.display = '';
                        // Rebuild discoveredFields to match filtered indices
                        discoveredFields = available;
                        let html = '';
                        available.forEach(function(f, i) {
                            const detail = [];
                            if (f.alwaysRequired) { detail.push('Required'); }
                            if (f.allowedValues && f.allowedValues.length > 0) { detail.push(f.allowedValues.length + ' options'); }
                            detail.push(f.workItemTypes.join(', '));
                            html += '<div class="import-item">'
                                + '<label><input type="checkbox" class="import-cb" data-index="' + i + '" '
                                + (f.alwaysRequired ? 'checked' : '') + ' /> '
                                + esc(f.name) + ' <code>' + esc(f.referenceName) + '</code></label>'
                                + '<span class="import-detail">' + esc(detail.join(' | ')) + '</span>'
                                + '</div>';
                        });
                        list.innerHTML = html;
                    }
                    document.getElementById('importSection').classList.add('visible');
                }
            });
        </script>
    </body>
    </html>`;
}

function getStateIndicatorsHtml(indicators: {state: string, indicator: string}[], nonce: string): string {
    const availableIndicators = [
        { value: '🔴', label: '🔴 Red' },
        { value: '🟠', label: '🟠 Orange' },
        { value: '🟡', label: '🟡 Yellow' },
        { value: '🟢', label: '🟢 Green' },
        { value: '🔵', label: '🔵 Blue' },
        { value: '🟣', label: '🟣 Purple' },
        { value: '🟤', label: '🟤 Brown' },
        { value: '⚫', label: '⚫ Black' },
        { value: '⚪', label: '⚪ White' },
        { value: '○', label: '○ Hollow' }
    ];

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <style>
            *, *::before, *::after { box-sizing: border-box; }
            body {
                font-family: var(--vscode-font-family);
                padding: 24px 32px;
                max-width: 600px;
                margin: 0 auto;
                color: var(--vscode-foreground);
            }
            h2 { margin-top: 0; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
            th, td {
                text-align: left;
                padding: 8px 10px;
                border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.2));
                font-size: 13px;
            }
            th {
                font-weight: 600;
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 0.3px;
                color: var(--vscode-descriptionForeground);
            }
            button {
                padding: 6px 14px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-size: 13px;
            }
            button:hover { background: var(--vscode-button-hoverBackground); }
            button.danger { background: #cc293d; }
            button.danger:hover { opacity: 0.85; }
            .add-row {
                display: flex;
                gap: 8px;
                align-items: center;
                margin-bottom: 16px;
            }
            input, select {
                padding: 6px 10px;
                border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.35));
                border-radius: 3px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                font-size: 13px;
            }
            input { flex: 1; }
            select { min-width: 120px; }
            .empty-state {
                text-align: center;
                padding: 24px;
                color: var(--vscode-descriptionForeground);
            }
            .hint {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 16px;
            }
        </style>
    </head>
    <body>
        <h2>State Indicators</h2>
        <p class="hint">Add colored indicators that appear next to work items in the tree view. Use <code>*</code> as the state name for a fallback indicator.</p>

        <div class="add-row">
            <input type="text" id="newState" placeholder="State name (e.g., Active, Closed, *)" />
            <select id="newIndicator">
                ${availableIndicators.map(i => `<option value="${escapeHtml(i.value)}">${escapeHtml(i.label)}</option>`).join('')}
            </select>
            <button id="addBtn">Add</button>
        </div>

        <div id="tableContainer"></div>

        <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            let indicators = ${JSON.stringify(indicators)};

            function esc(s) {
                const d = document.createElement('div');
                d.textContent = s || '';
                return d.innerHTML;
            }

            function renderTable() {
                const container = document.getElementById('tableContainer');
                if (indicators.length === 0) {
                    container.innerHTML = '<div class="empty-state">No state indicators configured.</div>';
                    return;
                }
                let html = '<table><thead><tr><th>State</th><th>Indicator</th><th></th></tr></thead><tbody>';
                indicators.forEach((ind, i) => {
                    html += '<tr>'
                        + '<td>' + esc(ind.state) + '</td>'
                        + '<td style="font-size:18px;">' + esc(ind.indicator) + '</td>'
                        + '<td><button class="danger remove-btn" data-index="' + i + '">Remove</button></td>'
                        + '</tr>';
                });
                html += '</tbody></table>';
                container.innerHTML = html;

                container.querySelectorAll('.remove-btn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        const idx = parseInt(btn.getAttribute('data-index'), 10);
                        indicators.splice(idx, 1);
                        save();
                        renderTable();
                    });
                });
            }

            document.getElementById('addBtn').addEventListener('click', () => {
                const stateInput = document.getElementById('newState');
                const indicatorSelect = document.getElementById('newIndicator');
                const state = stateInput.value.trim();
                if (!state) { return; }

                // Replace existing entry for this state
                indicators = indicators.filter(ind => ind.state !== state);
                indicators.push({ state: state, indicator: indicatorSelect.value });

                stateInput.value = '';
                save();
                renderTable();
            });

            document.getElementById('newState').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { document.getElementById('addBtn').click(); }
            });

            function save() {
                vscode.postMessage({ command: 'saveIndicators', indicators: indicators });
            }

            renderTable();
        </script>
    </body>
    </html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function deactivate() {}
