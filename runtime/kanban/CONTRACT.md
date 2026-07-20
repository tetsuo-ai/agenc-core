# Shared Contract (UI + Logic agents)

## DOM IDs / classes (must match)

### Structure
- `#app` — root
- `header.app-header` — title + controls
- `#board` — columns container
- `.column` — one column (`data-column-id="todo|doing|done"`)
- `.column-header` — title + count badge
- `.column-title`
- `.column-count`
- `.card-list` — droppable list inside column
- `.card` — draggable card (`data-card-id`, `draggable="true"`)
- `.card-title`
- `.card-actions` — edit/delete buttons
- `#add-card-form` — form with `#card-title-input`, `#card-column-select`, submit
- `#theme` is dark by default on `body.theme-dark`

### Columns (fixed)
1. `todo` — To Do
2. `doing` — In Progress
3. `done` — Done

### localStorage
- Key: `kanban-board-v1`
- Value JSON shape:
```json
{
  "cards": [
    { "id": "string", "title": "string", "columnId": "todo|doing|done", "order": 0 }
  ]
}
```

### JS API expected on window (for tests)
- `Kanban.load()`
- `Kanban.save()`
- `Kanban.addCard(title, columnId)`
- `Kanban.deleteCard(id)`
- `Kanban.moveCard(id, columnId, index)`
- `Kanban.getState()`
- extras: `Kanban.updateCardTitle(id, title)`, `Kanban.clearBoard({ skipConfirm })`

### Controls
- `#clear-board-btn` — clears all cards (confirm unless skipConfirm)

### UX
- Empty column shows subtle placeholder (CSS `:empty::before` on `.card-list`)
- Card count updates live
- Drag ghost / drop highlight on `.card-list.drag-over`
- Confirm before clear board; instant delete on cards
- Column accents via `data-column-id` (todo/doing/done)
