# Kanban Board

Dark-themed kanban board with drag-and-drop and localStorage persistence.

## Files

- `index.html` — structure
- `styles.css` — dark theme layout
- `app.js` — drag/drop, CRUD, localStorage
- `tests.html` — automated browser checks
- `CONTRACT.md` — shared DOM/API contract

## Features

- Columns: To Do, In Progress, Done (color accents)
- Add / edit / delete cards (double-click or Edit to rename)
- Drag and drop cards between columns (reorder supported)
- Clear board (with confirm)
- Persist board state in `localStorage` key `kanban-board-v1`
- Dark theme UI, responsive layout
- Seeds 3 sample cards on first visit

## Run

```bash
# from repo root
cd kanban
python3 -m http.server 8765
# open http://127.0.0.1:8765/
```

Or open `index.html` directly in a browser.

## Test

Open `tests.html` via the same static server, or:

```bash
cd kanban && python3 -m http.server 8765 &
google-chrome --headless=new --no-sandbox --virtual-time-budget=8000 \
  --dump-dom http://127.0.0.1:8765/tests.html | grep -o 'ALL PASSED[^<]*'
```

## API (`window.Kanban`)

- `load()` / `save()` / `getState()`
- `addCard(title, columnId)`
- `deleteCard(id)`
- `moveCard(id, columnId, index)`
- `updateCardTitle(id, title)`
- `clearBoard({ skipConfirm?: boolean })`
