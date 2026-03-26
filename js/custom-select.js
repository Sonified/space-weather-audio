/**
 * custom-select.js
 * Accessible custom dropdown replacing native <select> elements.
 * Preserves the native element (hidden) so .value and change events still work.
 * Menu is portaled to document.body to escape stacking contexts.
 *
 * Usage:
 *   import { upgradeAllSelects } from './custom-select.js';
 *   upgradeAllSelects();                         // upgrade all <select> on page
 *   upgradeAllSelects(document.getElementById('myDrawer'));  // scope to container
 */

// Track all instances so opening one closes the rest
const allInstances = [];

class CustomSelect {
    constructor(selectEl) {
        this.select = selectEl;
        this.isOpen = false;
        this.highlightedIndex = -1;
        this.typeBuffer = '';
        this.typeTimer = null;

        this._build();
        this._bindEvents();
        allInstances.push(this);
    }

    _build() {
        const sel = this.select;

        // Wrapper
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'csel';

        // Trigger button
        this.trigger = document.createElement('button');
        this.trigger.type = 'button';
        this.trigger.className = 'csel-trigger';
        this.trigger.setAttribute('role', 'combobox');
        this.trigger.setAttribute('aria-haspopup', 'listbox');
        this.trigger.setAttribute('aria-expanded', 'false');
        const menuId = sel.id + '-menu';
        this.trigger.setAttribute('aria-controls', menuId);

        this.label = document.createElement('span');
        this.label.className = 'csel-label';

        const arrow = document.createElement('span');
        arrow.className = 'csel-arrow';
        arrow.setAttribute('aria-hidden', 'true');

        this.trigger.appendChild(this.label);
        this.trigger.appendChild(arrow);

        // Menu — portaled to body to escape stacking contexts
        this.menu = document.createElement('div');
        this.menu.className = 'csel-menu';
        this.menu.id = menuId;
        this.menu.setAttribute('role', 'listbox');
        this.menu.setAttribute('aria-label', this._getLabel());

        this.options = [];
        this._buildOptions();

        // Transfer inline width from native select to wrapper
        const inlineWidth = sel.style.width;
        if (inlineWidth) {
            this.wrapper.style.width = inlineWidth;
            this.trigger.style.width = '100%';
            this.wrapper.style.minWidth = inlineWidth;
        }

        // Also transfer min-width
        const inlineMinWidth = sel.style.minWidth;
        if (inlineMinWidth) {
            this.wrapper.style.minWidth = inlineMinWidth;
        }

        this._syncLabel();

        // Assemble the complete wrapper off-DOM, then swap in one mutation
        sel.classList.add('csel-native');
        sel.inert = true;
        this.wrapper.appendChild(this.trigger);

        // Capture position before moving sel out of the DOM
        const parent = sel.parentNode;
        const next = sel.nextSibling;

        // Build complete tree off-DOM (sel moves into wrapper)
        this.wrapper.appendChild(sel);

        // Single DOM insertion: place the fully-assembled wrapper
        parent.insertBefore(this.wrapper, next);

        document.body.appendChild(this.menu);
    }

    _getLabel() {
        const parent = this.select.closest('.drawer-row, .slider-group, .param-row, .gear-popover-row');
        if (parent) {
            const lbl = parent.querySelector('label');
            if (lbl) return lbl.textContent.trim();
        }
        return this.select.id || 'Select';
    }

    _buildOptions() {
        this.menu.innerHTML = '';
        this.options = [];

        const children = this.select.children;
        let optIndex = 0;
        const addOption = (opt) => {
            if (opt.disabled && opt.value === '') return;
            const idx = optIndex++;
            const div = document.createElement('div');
            div.className = 'csel-option';
            div.setAttribute('role', 'option');
            div.setAttribute('data-value', opt.value);
            const isSelected = (opt.value === this.select.value);
            div.setAttribute('aria-selected', isSelected ? 'true' : 'false');
            div.textContent = opt.textContent;
            if (isSelected) div.classList.add('selected');

            div.addEventListener('mouseenter', () => this._highlight(idx));
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                this._selectIndex(idx);
                this._close();
                this.trigger.focus();
            });

            this.menu.appendChild(div);
            this.options.push(div);
        };

        Array.from(children).forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                const header = document.createElement('div');
                header.className = 'csel-group-label';
                header.textContent = child.label;
                this.menu.appendChild(header);
                Array.from(child.children).forEach(opt => addOption(opt));
            } else if (child.tagName === 'OPTION') {
                addOption(child);
            }
        });
    }

    _bindEvents() {
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.isOpen ? this._close() : this._open();
        });

        this.trigger.addEventListener('keydown', (e) => this._onKeyDown(e));

        this._outsideClick = (e) => {
            if (this.isOpen && !this.wrapper.contains(e.target) && !this.menu.contains(e.target)) {
                this._close();
            }
        };
        document.addEventListener('click', this._outsideClick);

        // Close menu when its scroll container scrolls (trigger moves away)
        // Reposition on window resize (viewport change, trigger stays put)
        this._onAncestorScroll = (e) => {
            if (!this.isOpen) return;
            // Only close if the scroll happened in an ancestor of the trigger
            // (not the menu itself scrolling its own options)
            if (e.target !== this.menu && e.target.contains?.(this.wrapper)) {
                this._close();
            }
        };
        this._reposition = () => {
            if (this.isOpen) this._positionMenu();
        };
        window.addEventListener('scroll', this._onAncestorScroll, true);
        window.addEventListener('resize', this._reposition);

        // Sync when native .value is set programmatically
        const origDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        const self = this;
        Object.defineProperty(this.select, 'value', {
            get() { return origDescriptor.get.call(this); },
            set(v) {
                origDescriptor.set.call(this, v);
                self._syncFromNative();
            }
        });
    }

    _positionMenu() {
        const triggerRect = this.trigger.getBoundingClientRect();
        this.menu.style.position = 'fixed';
        this.menu.style.left = triggerRect.left + 'px';
        this.menu.style.minWidth = triggerRect.width + 'px';

        // Position so the selected option overlaps the trigger (like native macOS selects)
        const selectedIdx = this.select.selectedIndex;
        const selectedOpt = this.options[selectedIdx];

        if (selectedOpt) {
            // Temporarily make menu visible but off-screen to measure
            this.menu.style.top = '-9999px';
            this.menu.style.opacity = '0';
            this.menu.classList.add('open');

            const optRect = selectedOpt.getBoundingClientRect();
            const menuRect = this.menu.getBoundingClientRect();
            const offsetWithinMenu = optRect.top - menuRect.top;

            // Place menu so selected option aligns with trigger
            let idealTop = triggerRect.top - offsetWithinMenu;

            // Clamp to viewport bounds
            const menuHeight = menuRect.height;
            const viewH = window.innerHeight;
            if (idealTop + menuHeight > viewH - 8) {
                idealTop = viewH - 8 - menuHeight;
            }
            if (idealTop < 8) {
                idealTop = 8;
            }

            this.menu.style.top = idealTop + 'px';
            this.menu.style.opacity = '';
        } else {
            // Fallback: position below trigger
            this.menu.style.top = (triggerRect.bottom + 4) + 'px';
        }
    }

    _open() {
        // Close any other open dropdown first
        for (const inst of allInstances) {
            if (inst !== this && inst.isOpen) inst._close();
        }
        this.isOpen = true;
        this.wrapper.classList.add('open');
        this.trigger.setAttribute('aria-expanded', 'true');

        this._positionMenu();
        this.menu.classList.add('open');

        const selectedIdx = this.select.selectedIndex;
        this._highlight(selectedIdx);

        // Scroll selected into view within the menu
        if (this.options[selectedIdx]) {
            this.options[selectedIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    _close() {
        this.isOpen = false;
        this.wrapper.classList.remove('open');
        this.menu.classList.remove('open');
        this.trigger.setAttribute('aria-expanded', 'false');
        this.highlightedIndex = -1;
    }

    _highlight(index) {
        if (index < 0 || index >= this.options.length) return;
        this.options.forEach(o => o.classList.remove('highlighted'));
        this.options[index].classList.add('highlighted');
        this.highlightedIndex = index;
        this.trigger.setAttribute('aria-activedescendant', this.menu.id + '-' + index);
        this.options[index].id = this.menu.id + '-' + index;
        this.options[index].scrollIntoView({ block: 'nearest' });
    }

    _selectIndex(index) {
        if (index < 0 || index >= this.options.length) return;
        const prevIndex = this.select.selectedIndex;

        this.select.selectedIndex = index;

        this.options.forEach(o => {
            o.classList.remove('selected');
            o.setAttribute('aria-selected', 'false');
        });
        this.options[index].classList.add('selected');
        this.options[index].setAttribute('aria-selected', 'true');

        this._syncLabel();

        if (prevIndex !== index) {
            this.select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    _syncLabel() {
        const opt = this.select.options[this.select.selectedIndex];
        this.label.textContent = opt ? opt.textContent : '';
    }

    _syncFromNative() {
        const idx = this.select.selectedIndex;
        this.options.forEach((o, i) => {
            o.classList.toggle('selected', i === idx);
            o.setAttribute('aria-selected', i === idx ? 'true' : 'false');
        });
        this._syncLabel();
    }

    _onKeyDown(e) {
        const { key } = e;

        switch (key) {
            case 'Enter':
            case ' ':
                e.preventDefault();
                if (this.isOpen) {
                    if (this.highlightedIndex >= 0) {
                        this._selectIndex(this.highlightedIndex);
                    }
                    this._close();
                } else {
                    this._open();
                }
                break;

            case 'Escape':
                if (this.isOpen) {
                    e.preventDefault();
                    this._close();
                }
                break;

            case 'ArrowDown':
                e.preventDefault();
                if (!this.isOpen) {
                    this._open();
                } else {
                    const next = Math.min(this.highlightedIndex + 1, this.options.length - 1);
                    this._highlight(next);
                }
                break;

            case 'ArrowUp':
                e.preventDefault();
                if (!this.isOpen) {
                    this._open();
                } else {
                    const prev = Math.max(this.highlightedIndex - 1, 0);
                    this._highlight(prev);
                }
                break;

            case 'Home':
                if (this.isOpen) {
                    e.preventDefault();
                    this._highlight(0);
                }
                break;

            case 'End':
                if (this.isOpen) {
                    e.preventDefault();
                    this._highlight(this.options.length - 1);
                }
                break;

            case 'Tab':
                if (this.isOpen) {
                    this._close();
                }
                break;

            default:
                if (key.length === 1) {
                    this._typeAhead(key);
                }
                break;
        }
    }

    _typeAhead(char) {
        clearTimeout(this.typeTimer);
        this.typeBuffer += char.toLowerCase();
        this.typeTimer = setTimeout(() => { this.typeBuffer = ''; }, 500);

        const match = this.options.findIndex(o =>
            o.textContent.toLowerCase().startsWith(this.typeBuffer)
        );
        if (match >= 0) {
            if (this.isOpen) {
                this._highlight(match);
            } else {
                this._selectIndex(match);
            }
        }
    }

    /** Rebuild options (call if <option>s change dynamically) */
    refresh() {
        this._buildOptions();
        this._syncLabel();
    }

    destroy() {
        document.removeEventListener('click', this._outsideClick);
        window.removeEventListener('scroll', this._onAncestorScroll, true);
        window.removeEventListener('resize', this._reposition);
        this.wrapper.parentNode.insertBefore(this.select, this.wrapper);
        this.wrapper.remove();
        this.menu.remove();
        this.select.classList.remove('csel-native');
        this.select.inert = false;
        const idx = allInstances.indexOf(this);
        if (idx >= 0) allInstances.splice(idx, 1);
    }
}

/**
 * Upgrade all native <select> elements within a container (default: document).
 * Returns a Map of select ID → CustomSelect instance for later .refresh() calls.
 */
function upgradeAllSelects(container = document) {
    const instances = new Map();
    container.querySelectorAll('select:not(.csel-native)').forEach(sel => {
        const cs = new CustomSelect(sel);
        if (sel.id) instances.set(sel.id, cs);
    });
    return instances;
}

/**
 * Refresh the CustomSelect instance wrapping a given native <select> element.
 * Call after programmatically changing the <option>s via innerHTML.
 */
function refreshSelectById(id) {
    const inst = allInstances.find(cs => cs.select.id === id);
    if (inst) inst.refresh();
}

// Expose globally — loaded as regular <script> for instant execution,
// also importable from modules via window.__customSelect
window.__customSelect = { upgradeAllSelects, refreshSelectById, CustomSelect, _allInstances: allInstances };
