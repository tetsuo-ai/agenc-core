/**
 * Kanban board — state, render, drag-and-drop, localStorage.
 * Contract: kanban/CONTRACT.md
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'kanban-board-v1';
  var COLUMN_IDS = ['todo', 'doing', 'done'];

  /** @type {{ cards: Array<{id: string, title: string, columnId: string, order: number}> }} */
  var state = { cards: [] };

  var dragCardId = null;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function uid() {
    return (
      'card-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 9)
    );
  }

  function normalizeColumnId(columnId) {
    return COLUMN_IDS.indexOf(columnId) !== -1 ? columnId : 'todo';
  }

  function sortByOrder(a, b) {
    return (a.order || 0) - (b.order || 0);
  }

  function cardsInColumn(columnId) {
    return state.cards
      .filter(function (c) {
        return c.columnId === columnId;
      })
      .sort(sortByOrder);
  }

  function reindexColumn(columnId) {
    var list = cardsInColumn(columnId);
    for (var i = 0; i < list.length; i++) {
      list[i].order = i;
    }
  }

  function findCard(id) {
    for (var i = 0; i < state.cards.length; i++) {
      if (state.cards[i].id === id) return state.cards[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        seedDefaults();
        save();
        return getState();
      }
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.cards)) {
        console.error('[Kanban] Invalid storage shape; reseeding');
        seedDefaults();
        save();
        return getState();
      }
      state = {
        cards: parsed.cards
          .filter(function (c) {
            return c && typeof c.id === 'string' && typeof c.title === 'string';
          })
          .map(function (c) {
            return {
              id: c.id,
              title: c.title,
              columnId: normalizeColumnId(c.columnId),
              order: typeof c.order === 'number' ? c.order : 0,
            };
          }),
      };
      COLUMN_IDS.forEach(reindexColumn);
    } catch (err) {
      console.error('[Kanban] load failed:', err);
      seedDefaults();
    }
    return getState();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error('[Kanban] save failed:', err);
    }
  }

  function getState() {
    return JSON.parse(JSON.stringify(state));
  }

  function seedDefaults() {
    state = {
      cards: [
        {
          id: uid(),
          title: 'Welcome to Kanban',
          columnId: 'todo',
          order: 0,
        },
        {
          id: uid(),
          title: 'Drag cards between columns',
          columnId: 'doing',
          order: 0,
        },
        {
          id: uid(),
          title: 'Double-click a title to edit',
          columnId: 'done',
          order: 0,
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  function addCard(title, columnId) {
    var t = (title == null ? '' : String(title)).trim();
    if (!t) {
      console.error('[Kanban] addCard: title required');
      return null;
    }
    var col = normalizeColumnId(columnId);
    var card = {
      id: uid(),
      title: t,
      columnId: col,
      order: cardsInColumn(col).length,
    };
    state.cards.push(card);
    save();
    render();
    return card.id;
  }

  function deleteCard(id) {
    var before = state.cards.length;
    var removed = null;
    state.cards = state.cards.filter(function (c) {
      if (c.id === id) {
        removed = c;
        return false;
      }
      return true;
    });
    if (!removed) {
      console.error('[Kanban] deleteCard: not found', id);
      return false;
    }
    reindexColumn(removed.columnId);
    save();
    render();
    return before !== state.cards.length;
  }

  /**
   * Move card to columnId at index (0-based among cards in that column).
   */
  function moveCard(id, columnId, index) {
    var card = findCard(id);
    if (!card) {
      console.error('[Kanban] moveCard: not found', id);
      return false;
    }
    var col = normalizeColumnId(columnId);
    var fromCol = card.columnId;

    // Pull out of array conceptually by reassigning column + order via reindex
    card.columnId = col;

    var siblings = state.cards
      .filter(function (c) {
        return c.columnId === col && c.id !== id;
      })
      .sort(sortByOrder);

    var idx = typeof index === 'number' ? index : siblings.length;
    if (idx < 0) idx = 0;
    if (idx > siblings.length) idx = siblings.length;

    siblings.splice(idx, 0, card);
    for (var i = 0; i < siblings.length; i++) {
      siblings[i].order = i;
    }

    if (fromCol !== col) {
      reindexColumn(fromCol);
    }

    save();
    render();
    return true;
  }

  function updateCardTitle(id, title) {
    var card = findCard(id);
    if (!card) {
      console.error('[Kanban] updateCardTitle: not found', id);
      return false;
    }
    var t = (title == null ? '' : String(title)).trim();
    if (!t) {
      console.error('[Kanban] updateCardTitle: empty title');
      return false;
    }
    card.title = t;
    save();
    render();
    return true;
  }

  function clearBoard(opts) {
    var options = opts || {};
    var skipConfirm = !!options.skipConfirm;
    if (!skipConfirm && state.cards.length > 0) {
      var ok =
        typeof window.confirm === 'function'
          ? window.confirm('Clear all cards from the board?')
          : true;
      if (!ok) return false;
    }
    state = { cards: [] };
    save();
    render();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function render() {
    var board = document.getElementById('board');
    if (!board) {
      console.error('[Kanban] #board not found');
      return;
    }

    COLUMN_IDS.forEach(function (columnId) {
      var column =
        board.querySelector('.column[data-column-id="' + columnId + '"]') ||
        document.querySelector('.column[data-column-id="' + columnId + '"]');
      if (!column) {
        console.error('[Kanban] column missing:', columnId);
        return;
      }

      var list = column.querySelector('.card-list');
      var countEl = column.querySelector('.column-count');
      var cards = cardsInColumn(columnId);

      if (countEl) {
        countEl.textContent = String(cards.length);
      }

      if (!list) {
        console.error('[Kanban] .card-list missing in', columnId);
        return;
      }

      // Preserve drag-over class if mid-drag
      // Leave list empty when no cards so CSS :empty::before placeholder shows
      var wasDragOver = list.classList.contains('drag-over');
      list.innerHTML = '';

      cards.forEach(function (card) {
        list.appendChild(createCardElement(card));
      });

      if (wasDragOver) {
        list.classList.add('drag-over');
      }
    });
  }

  function createCardElement(card) {
    var el = document.createElement('article');
    el.className = 'card';
    el.draggable = true;
    el.dataset.cardId = card.id;
    el.setAttribute('role', 'listitem');

    var title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = card.title;
    title.title = 'Double-click to edit';
    title.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      beginInlineEdit(title, card.id);
    });

    var actions = document.createElement('div');
    actions.className = 'card-actions';

    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'card-edit';
    editBtn.setAttribute('aria-label', 'Edit card');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      beginInlineEdit(title, card.id);
    });

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'card-delete';
    delBtn.setAttribute('aria-label', 'Delete card');
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteCard(card.id);
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    el.appendChild(title);
    el.appendChild(actions);

    el.addEventListener('dragstart', onDragStart);
    el.addEventListener('dragend', onDragEnd);

    return el;
  }

  function beginInlineEdit(titleEl, cardId) {
    var card = findCard(cardId);
    if (!card || titleEl.querySelector('input')) return;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'card-title-input';
    input.value = card.title;
    input.setAttribute('aria-label', 'Edit card title');

    var original = card.title;
    titleEl.textContent = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();

    var finished = false;
    function finish(commit) {
      if (finished) return;
      finished = true;
      var next = input.value.trim();
      if (commit && next && next !== original) {
        updateCardTitle(cardId, next);
      } else {
        // restore without full re-render if cancelled / empty
        titleEl.textContent = original;
      }
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', function () {
      finish(true);
    });
  }

  // ---------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------

  function onDragStart(e) {
    var cardEl = e.currentTarget;
    dragCardId = cardEl.dataset.cardId || null;
    if (!dragCardId) return;
    cardEl.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragCardId);
      e.dataTransfer.setData('application/x-kanban-card', dragCardId);
    } catch (_) {
      /* IE / restricted */
    }
  }

  function onDragEnd(e) {
    var cardEl = e.currentTarget;
    cardEl.classList.remove('dragging');
    dragCardId = null;
    document.querySelectorAll('.card-list.drag-over').forEach(function (list) {
      list.classList.remove('drag-over');
    });
  }

  function getDropIndex(list, clientY) {
    var cards = Array.prototype.slice.call(
      list.querySelectorAll('.card:not(.dragging)')
    );
    if (cards.length === 0) return 0;

    for (var i = 0; i < cards.length; i++) {
      var rect = cards[i].getBoundingClientRect();
      var mid = rect.top + rect.height / 2;
      if (clientY < mid) return i;
    }
    return cards.length;
  }

  function findCardList(target) {
    if (!target || !target.closest) return null;
    return target.closest('.card-list');
  }

  function onDragOver(e) {
    var list = findCardList(e.target);
    if (!list) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'move';
    } catch (_) {}
    list.classList.add('drag-over');
  }

  function onDragEnter(e) {
    var list = findCardList(e.target);
    if (!list) return;
    e.preventDefault();
    list.classList.add('drag-over');
  }

  function onDragLeave(e) {
    var list = findCardList(e.target);
    if (!list) return;
    // Only remove when leaving the list itself (not entering a child)
    var related = e.relatedTarget;
    if (related && list.contains(related)) return;
    list.classList.remove('drag-over');
  }

  function onDrop(e) {
    var list = findCardList(e.target);
    if (!list) return;
    e.preventDefault();
    list.classList.remove('drag-over');

    var id = dragCardId;
    try {
      id =
        e.dataTransfer.getData('application/x-kanban-card') ||
        e.dataTransfer.getData('text/plain') ||
        dragCardId;
    } catch (_) {}

    if (!id) {
      console.error('[Kanban] drop: no card id');
      return;
    }

    var column = list.closest('.column');
    var columnId = column && column.dataset.columnId;
    if (!columnId) {
      console.error('[Kanban] drop: no column id');
      return;
    }

    var index = getDropIndex(list, e.clientY);
    moveCard(id, columnId, index);
    dragCardId = null;
  }

  function bindDnD() {
    var board = document.getElementById('board');
    if (!board) {
      console.error('[Kanban] bindDnD: #board missing');
      return;
    }

    // Delegate on board for lists (lists are stable in markup)
    board.addEventListener('dragover', onDragOver);
    board.addEventListener('dragenter', onDragEnter);
    board.addEventListener('dragleave', onDragLeave);
    board.addEventListener('drop', onDrop);
  }

  // ---------------------------------------------------------------------------
  // Form
  // ---------------------------------------------------------------------------

  function bindForm() {
    var form = document.getElementById('add-card-form');
    if (!form) {
      console.error('[Kanban] #add-card-form missing');
      return;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var titleInput = document.getElementById('card-title-input');
      var columnSelect = document.getElementById('card-column-select');

      if (!titleInput) {
        console.error('[Kanban] #card-title-input missing');
        return;
      }

      var title = titleInput.value;
      var columnId =
        columnSelect && columnSelect.value ? columnSelect.value : 'todo';

      var id = addCard(title, columnId);
      if (id) {
        titleInput.value = '';
        titleInput.focus();
      }
    });

    var clearBtn = document.getElementById('clear-board-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        clearBoard();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function init() {
    load();
    bindForm();
    bindDnD();
    render();
  }

  // Public API
  window.Kanban = {
    load: function () {
      var s = load();
      render();
      return s;
    },
    save: save,
    addCard: addCard,
    deleteCard: deleteCard,
    moveCard: moveCard,
    getState: getState,
    // extras (not required by contract but useful)
    render: render,
    updateCardTitle: updateCardTitle,
    clearBoard: clearBoard,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
