# Changelog

## [0.3.0] - 2026-02-09

### Added
- **Custom Fields** — Define organization-specific fields per work item type that appear in detail panels and are prompted during creation when marked as required. Managed via Command Palette: "ADO: Manage Custom Fields".
- **Import from ADO** — Auto-discover required fields and their allowed values directly from your Azure DevOps organization and import them into your custom fields configuration.
- **State Indicators** — Configurable colored emoji indicators next to work items in the tree view showing state at a glance. Managed via Command Palette: "ADO: Configure State Indicators".
- **Story Points** — Story Points field displayed and editable on User Story detail panels.
- **Refresh Work Item** — Right-click context menu option to refresh a single work item and its children in the tree. Also refreshes the detail panel if one is open for that item.
- **Stable tree item IDs** — Tree items now use stable identifiers so targeted refreshes and state preservation work correctly across tree updates.

### Fixed
- **Tag editing** — Removing a tag and saving now correctly removes it. Previously ADO's `add` operation on `System.Tags` would append rather than replace; now uses `replace`.
- **Drag and drop reparenting** — Work items dragged to a new parent now correctly remove the old parent link. The `removeParentLink` call was not fetching relations from ADO, so the existing parent link was never found.
- **Refresh button** — The toolbar refresh button now clears the data cache and fires immediately, instead of serving stale cached data through a debounced refresh.
- **Tag input layout** — The "Add Tag" input now always appears on its own row below tag bubbles, preventing it from overflowing when many tags are present.
- **Webview button handlers** — Edit/Delete buttons in the Custom Fields and State Indicators management panels now work correctly under Content Security Policy (replaced inline `onclick` handlers with DOM event listeners).

## [0.2.0] - 2026-02-09

### Added
- Initial published release
- Hierarchical backlog tree (Epics > Features > User Stories / Bugs) organized by area path
- ADO-styled work item detail panels with inline editing
- Work item creation with automatic parent linking
- Rich text toolbar for Description and Acceptance Criteria
- Assigned To autocomplete with background team member loading
- Filtering by search text, iteration path, tags, and assigned person
- Drag and drop reparenting between tree nodes
- Quick actions: change state, delete, open in browser
- Team member info panel

## [0.1.0] - 2026-02-09

### Added
- Initial development release
