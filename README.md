# Azure DevOps Backlog Explorer

A VS Code extension for viewing and managing Azure DevOps backlog items directly from the editor. Browse your work item hierarchy, edit fields with a rich ADO-style panel, and stay in your flow without switching to the browser.

## Features

- **Hierarchical tree view** — Browse Epics > Features > User Stories / Bugs organized by area path
- **Work item panel** — Open any item in an ADO-styled editor with inline title, color-coded type badges, rich text description/acceptance criteria, and tag management
- **Create work items** — Right-click to create Epics, Features, User Stories, or Bugs with automatic parent linking
- **Inline editing** — Edit title, state, iteration, assigned to, tags, description, and acceptance criteria without leaving VS Code
- **Assigned To autocomplete** — Team members are eagerly loaded and available as type-ahead suggestions
- **Rich text toolbar** — Bold, italic, headings, lists, links, tables, font color, highlighting, and more — all ADO-compatible
- **Filtering** — Filter by search text / ID, iteration path, tags, or assigned person
- **Drag and drop** — Reparent work items by dragging them in the tree
- **Context actions** — Change state, delete, or open in browser from the right-click menu
- **Team info** — View team members for any configured area path

## Prerequisites

- [VS Code](https://code.visualstudio.com/) v1.85.0 or later
- An Azure DevOps organization with a project
- A [Personal Access Token (PAT)](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) with **Work Items (Read & Write)** scope

## Setup

### 1. Install the extension

**From VSIX (local build):**

```bash
npm install
npm run compile
npx @vscode/vsce package
code --install-extension azure-devops-backlog-explorer-0.1.0.vsix
```

**For development (Extension Development Host):**

Press `F5` in VS Code to launch a new window with the extension loaded.

### 2. Configure settings

Open **Settings** (`Cmd+,` / `Ctrl+,`) and search for `adoBacklog`, or add to your `settings.json`:

```jsonc
{
  "adoBacklog.organizationUrl": "https://dev.azure.com/yourorg",
  "adoBacklog.personalAccessToken": "your-pat-here",
  "adoBacklog.project": "YourProject",
  "adoBacklog.areaPaths": [
    "YourProject\\TeamA",
    "YourProject\\TeamB"
  ],
  "adoBacklog.defaultIterationPath": "YourProject\\Sprint 1"
}
```

| Setting | Description |
|---------|-------------|
| `adoBacklog.organizationUrl` | Azure DevOps org URL (e.g. `https://dev.azure.com/yourorg`) |
| `adoBacklog.personalAccessToken` | PAT with Work Items read/write access |
| `adoBacklog.project` | Project name |
| `adoBacklog.areaPaths` | Array of area paths to display in the tree |
| `adoBacklog.defaultIterationPath` | Default iteration for newly created work items |

### 3. Use the extension

Click the Azure DevOps icon in the activity bar to open the Backlog panel. Your configured area paths appear as top-level nodes — expand them to browse Epics, Features, and child items.

## Testing

The project includes a basic integration test suite using the VS Code test framework.

```bash
# Compile and run tests
npm run pretest
npm test
```

Tests run in an Extension Development Host via `@vscode/test-electron`. The test entry point is `.vscode-test.mjs` and test files live in `src/test/`.

To add tests, create files in `src/test/` following the existing pattern in `extension.test.ts`. Tests use the `mocha` suite/test style with Node's `assert` module.

## Project Structure

```
src/
  extension.ts            # Extension entry point, commands, webview panels
  adoService.ts           # Azure DevOps API client, caching, CRUD operations
  adoBacklogProvider.ts   # Tree data provider and drag-and-drop controller
  test/
    extension.test.ts     # Integration tests
resources/
  icon.svg                # Activity bar icon (Azure DevOps logo)
```

## Developing

### Getting started

```bash
git clone <repo-url>
cd AzureDevOpsBacklogExplorer
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host with the extension loaded. Use `npm run watch` for automatic recompilation on save.

### Key files

- **`adoService.ts`** — All Azure DevOps API interactions. Uses `azure-devops-node-api` with a 5-minute TTL cache. Add new API methods here.
- **`adoBacklogProvider.ts`** — Implements `TreeDataProvider` and `TreeDragAndDropController` for the sidebar tree. Handles hierarchy, pagination, filtering, and drag-and-drop reparenting.
- **`extension.ts`** — Registers commands, builds webview HTML for work item panels and team info. The `getWorkItemHtml()` function contains the full panel UI including styles and client-side JavaScript.

### Adding a new feature

1. **New API call** — Add a method to `AdoService` in `adoService.ts`. Use `getCached`/`setCache` for caching.
2. **New tree node type** — Update `AdoBacklogProvider` in `adoBacklogProvider.ts` to return new `TreeItem` entries.
3. **New command** — Register in `extension.ts` `activate()` and declare in `package.json` under `contributes.commands` and `contributes.menus`.
4. **New work item panel field** — Add HTML in `getWorkItemHtml()`, handle in the `onDidReceiveMessage` callback, and include in the save payload.

### Building a VSIX

```bash
npx @vscode/vsce package
```

Optionally pass `--allow-missing-repository` if you haven't set a `repository` field in `package.json`.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes and ensure `npm run compile` passes with no errors
4. Add or update tests in `src/test/` for any new functionality
5. Commit your changes with a descriptive message
6. Push to your fork and open a Pull Request

### Guidelines

- Keep the ADO API interactions in `adoService.ts` — don't scatter API calls across files
- Use the existing cache pattern (`getCached`/`setCache`) for any new API calls
- Webview HTML is built as template literals in `extension.ts` — keep styles scoped within each panel's `<style>` block
- Test against a real Azure DevOps project to verify API compatibility before submitting
- Follow the existing code style — TypeScript strict mode, no unused variables

## License

ISC
