/* global React */
import ConfirmModal from "./ConfirmModal.js";
import {copyToClipboard} from "../utils.js";

const h = React.createElement;

const MAX_SEARCH_RESULTS = 100;

/**
 * AIAssistModal
 *
 * Props:
 * - isOpen: boolean
 * - title: string
 * - mode: "generate" | "fix"
 * - kindLabel: string (e.g. "SOQL" or "SQL (CTE)")
 * - initialPrompt: string
 * - query: string (for fix mode)
 * - errorText: string (for fix mode)
 * - onClose: () => void
 * - onResolveSObjects: ({promptText}) => Promise<{suggestions: string[], allObjects: {name,label}[]}>
 * - onRequest: ({promptText, selectedObjects: string[]}) => Promise<string>
 * - onInsert: (queryText) => void
 */
export default class AIAssistModal extends React.Component {
  constructor(props) {
    super(props);
    this.onConfirm = this.onConfirm.bind(this);
    this.onCopy = this.onCopy.bind(this);
    this.onPromptInput = this.onPromptInput.bind(this);
    this.onReset = this.onReset.bind(this);
    this.onBack = this.onBack.bind(this);
    this.onToggleObject = this.onToggleObject.bind(this);
    this.onSearchInput = this.onSearchInput.bind(this);
    this.onSelectAllMatching = this.onSelectAllMatching.bind(this);

    this.state = this._initialState(props);
  }

  _initialState(props) {
    return {
      promptText: (props || this.props).initialPrompt || "",
      phase: "prompt",
      isLoadingObjects: false,
      allObjects: [], // [{name, label}] — full org SObject list
      selectedMap: {}, // {name: true} — selected objects
      searchText: "",
      result: "",
      error: ""
    };
  }

  componentDidUpdate(prevProps) {
    const openedNow = !prevProps.isOpen && this.props.isOpen;
    const modeChanged = prevProps.mode !== this.props.mode;
    if (openedNow || modeChanged) {
      this.setState(this._initialState());
    }
  }

  // --- input handlers ---

  onPromptInput(e) { this.setState({promptText: e.target.value}); }
  onSearchInput(e) { this.setState({searchText: e.target.value}); }

  onReset() { this.setState(this._initialState()); }
  onBack() { this.setState({phase: "prompt", error: ""}); }

  onToggleObject(name) {
    this.setState(prev => {
      const next = {...prev.selectedMap};
      if (next[name]) {
        delete next[name];
      } else {
        next[name] = true;
      }
      return {selectedMap: next, error: ""};
    });
  }

  onSelectAllMatching() {
    const filtered = this._filteredObjects();
    this.setState(prev => {
      const next = {...prev.selectedMap};
      for (const obj of filtered) {
        next[obj.name] = true;
      }
      return {selectedMap: next, error: ""};
    });
  }

  /**
   * Returns the list of objects to show in the scrollable list.
   * - No search text → selected objects only
   * - Search text → fuzzy-filtered from allObjects
   */
  _filteredObjects() {
    const {allObjects, selectedMap, searchText} = this.state;
    const q = searchText.trim().toLowerCase();
    if (!q) {
      // Show selected objects only
      return allObjects.filter(o => selectedMap[o.name]);
    }
    return allObjects.filter(o =>
      o.name.toLowerCase().includes(q) || (o.label || "").toLowerCase().includes(q)
    );
  }

  // --- main action ---

  async onConfirm() {
    const {onRequest, onInsert, onResolveSObjects} = this.props;
    const {phase, result, promptText, selectedMap, isLoadingObjects} = this.state;

    if (isLoadingObjects) return;

    // Phase: result → insert
    if (phase === "result" && result) {
      onInsert(result);
      return;
    }

    // Phase: prompt → resolve schema objects
    if (phase === "prompt") {
      try {
        this.setState({isLoadingObjects: true, error: ""});
        const {suggestions, allObjects} = await onResolveSObjects({promptText});
        const map = {};
        for (const name of (suggestions || [])) {
          map[name] = true;
        }
        this.setState({
          phase: "objects",
          allObjects: allObjects || [],
          selectedMap: map,
          isLoadingObjects: false
        });
      } catch (e) {
        this.setState({error: e?.message || String(e), isLoadingObjects: false});
      }
      return;
    }

    // Phase: objects → generate
    if (phase === "objects") {
      const selected = Object.keys(selectedMap).filter(k => selectedMap[k]);
      if (selected.length === 0) {
        this.setState({error: "Select at least one schema object to ground the AI response."});
        return;
      }
      try {
        this.setState({phase: "working", error: ""});
        const generated = await onRequest({promptText, selectedObjects: selected});
        this.setState({phase: "result", result: generated || ""});
      } catch (e) {
        this.setState({phase: "objects", error: e?.message || String(e)});
      }
      return;
    }
  }

  onCopy() {
    const text = this.state.result || "";
    if (text) copyToClipboard(text);
  }

  // --- render ---

  render() {
    const {isOpen, title, mode, kindLabel, query, errorText, onClose} = this.props;
    if (!isOpen) return null;

    const {promptText, phase, isLoadingObjects, selectedMap, searchText, result, error} = this.state;
    const hasResult = phase === "result" && !!result;
    const selectedCount = Object.keys(selectedMap).filter(k => selectedMap[k]).length;

    // Determine visible objects in list
    const filtered = phase === "objects" ? this._filteredObjects() : [];
    const hasSearch = searchText.trim().length > 0;
    const totalMatches = filtered.length;
    const displayList = filtered.slice(0, MAX_SEARCH_RESULTS);
    const truncated = totalMatches > MAX_SEARCH_RESULTS;

    // Button label
    let confirmLabel;
    if (isLoadingObjects) confirmLabel = "Loading\u2026";
    else if (phase === "result") confirmLabel = "Insert";
    else if (phase === "working") confirmLabel = "Working\u2026";
    else if (phase === "objects") confirmLabel = mode === "fix" ? "Fix" : "Generate";
    else confirmLabel = "Next \u2192";

    const confirmDisabled = isLoadingObjects
      || phase === "working"
      || (phase === "objects" && selectedCount === 0);

    return h(ConfirmModal, {
      isOpen: true,
      title: title || "AI assistance",
      onConfirm: confirmDisabled ? null : this.onConfirm,
      onCancel: onClose,
      confirmLabel,
      cancelLabel: "Close",
      confirmVariant: "brand",
      cancelVariant: "neutral",
      confirmDisabled
    },

    // Description
    h("div", {className: "slds-text-body_small slds-text-color_weak slds-m-bottom_small"},
      "Generate or fix a ", h("strong", {}, kindLabel || "query"), " using Gemini. ",
      "All fields and types for selected objects will be sent as context."
    ),

    // --- Fix-mode context ---
    phase !== "result" && mode === "fix" && h("div", {className: "slds-m-bottom_small"},
      errorText && h("div", {className: "slds-box slds-box_x-small slds-theme_error slds-m-bottom_x-small"},
        h("div", {className: "slds-text-body_small"}, errorText)
      ),
      query && h("div", {className: "slds-form-element"},
        h("label", {className: "slds-form-element__label"}, "Current query"),
        h("div", {className: "slds-form-element__control"},
          h("textarea", {className: "slds-textarea", readOnly: true, value: query, style: {minHeight: "120px"}})
        )
      )
    ),

    // --- Prompt textarea ---
    phase !== "result" && h("div", {className: "slds-form-element"},
      h("label", {className: "slds-form-element__label"},
        mode === "fix" ? "Fix instructions (optional)" : "Describe the query you want"
      ),
      h("div", {className: "slds-form-element__control"},
        h("textarea", {
          className: "slds-textarea",
          value: promptText,
          onInput: this.onPromptInput,
          placeholder: mode === "fix"
            ? "Example: Use CreatedDate = LAST_N_DAYS:30 and include Owner.Name"
            : "Example: accounts with their installed package versions where package name contains \"rec\"",
          style: {minHeight: "100px"},
          disabled: phase !== "prompt"
        })
      )
    ),

    // --- Schema object picker ---
    phase === "objects" && h("div", {className: "slds-m-top_small"},
      h("label", {className: "slds-form-element__label"},
        "Schema objects ",
        h("span", {className: "slds-text-body_small slds-text-color_weak"}, `(${selectedCount} selected)`)
      ),
      h("div", {className: "slds-text-body_small slds-text-color_weak slds-m-bottom_xx-small"},
        "Select which Salesforce objects to include as schema context for the AI model."
      ),

      // Search bar + Select all
      h("div", {className: "slds-grid slds-grid_vertical-align-end slds-m-bottom_xx-small"},
        h("div", {className: "slds-form-element", style: {flex: "1 1 auto"}},
          h("input", {
            type: "text",
            className: "slds-input",
            placeholder: "Filter objects\u2026",
            value: searchText,
            onInput: this.onSearchInput
          })
        ),
        hasSearch && totalMatches > 0 && h("button", {
          className: "slds-button slds-button_neutral slds-m-left_x-small",
          onClick: this.onSelectAllMatching,
          title: `Select all ${totalMatches} matching objects`
        }, `Select all (${totalMatches})`)
      ),

      // Object list
      displayList.length > 0
        ? h("div", {
          className: "slds-box slds-box_x-small",
          style: {maxHeight: "240px", overflowY: "auto", padding: "2px 8px"}
        },
        displayList.map(obj =>
          h("label", {
            key: obj.name,
            style: {display: "flex", alignItems: "center", padding: "3px 0", cursor: "pointer"}
          },
          h("input", {
            type: "checkbox",
            checked: !!selectedMap[obj.name],
            onChange: () => this.onToggleObject(obj.name)
          }),
          h("span", {style: {marginLeft: "8px"}},
            obj.name,
            obj.label && obj.label !== obj.name
              ? h("span", {className: "slds-text-color_weak"}, ` (${obj.label})`)
              : null
          )
          )
        ),
        truncated && h("div", {
          className: "slds-text-body_small slds-text-color_weak",
          style: {padding: "6px 0", textAlign: "center"}
        }, `Showing ${MAX_SEARCH_RESULTS} of ${totalMatches} matches \u2014 refine your search`)
        )
        : h("div", {className: "slds-text-color_weak slds-m-top_x-small slds-text-body_small"},
          hasSearch
            ? "No objects match your filter."
            : (selectedCount === 0
              ? "No objects selected. Use the search above to find and select objects."
              : null)
        )
    ),

    // --- Action buttons ---
    h("div", {className: "slds-grid slds-grid_align-spread slds-m-top_small"},
      h("div", {},
        h("button", {
          className: "slds-button slds-button_neutral",
          onClick: this.onReset,
          disabled: phase === "working"
        }, "Reset"),
        phase === "objects" && h("button", {
          className: "slds-button slds-button_neutral slds-m-left_x-small",
          onClick: this.onBack
        }, "\u2190 Back"),
        hasResult && h("button", {
          className: "slds-button slds-button_neutral slds-m-left_x-small",
          onClick: this.onCopy,
          title: "Copy result to clipboard"
        }, "Copy")
      ),
      (phase === "working" || isLoadingObjects)
        && h("div", {className: "slds-text-body_small slds-text-color_weak"},
          isLoadingObjects ? "Loading objects\u2026" : "Contacting Gemini\u2026"
        )
    ),

    // --- Error ---
    error && h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-top_small", role: "alert"},
      h("span", {className: "slds-assistive-text"}, "Error"),
      h("div", {}, error)
    ),

    // --- Generated result ---
    hasResult && h("div", {className: "slds-m-top_medium"},
      h("label", {className: "slds-form-element__label"}, "Generated query"),
      h("div", {className: "slds-form-element__control"},
        h("textarea", {className: "slds-textarea", readOnly: true, value: result, style: {minHeight: "160px"}})
      )
    )
    );
  }
}
