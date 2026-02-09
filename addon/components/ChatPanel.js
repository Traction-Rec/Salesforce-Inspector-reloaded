/* global React */
const h = React.createElement;

// ---------------------------------------------------------------------------
// Lightweight Markdown → React element renderer
// Supports: headings, bold, italic, inline code, fenced code blocks,
//           ordered/unordered lists, and paragraphs.
// ---------------------------------------------------------------------------

/**
 * Parse inline markdown (bold, italic, inline code) into React elements.
 */
function renderInlineMarkdown(text) {
  if (!text) return text;
  const parts = [];
  // Order matters: code first, then bold, then italic
  const regex = /(`[^`]+?`)|\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIdx = 0;
  let match;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    if (match[1] !== undefined) {
      parts.push(h("code", {key: key++, className: "chat-md-inline-code"}, match[1].slice(1, -1)));
    } else if (match[2] !== undefined) {
      parts.push(h("strong", {key: key++}, match[2]));
    } else if (match[3] !== undefined) {
      parts.push(h("em", {key: key++}, match[3]));
    }
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx === 0) return text; // no inline formatting found
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts;
}

/**
 * Render a section of markdown text (no fenced code blocks) into React block elements.
 */
function renderMarkdownBlocks(text, startKey) {
  const elements = [];
  let key = startKey || 0;
  const blocks = text.split(/\n{2,}/);

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;

    const lines = block.split("\n");
    let i = 0;

    while (i < lines.length) {
      const trimLine = lines[i].trim();
      if (!trimLine) { i++; continue; }

      // Heading
      const hMatch = trimLine.match(/^(#{1,6})\s+(.+)$/);
      if (hMatch) {
        const level = Math.min(hMatch[1].length, 4);
        elements.push(h("div", {key: key++, className: `chat-md-heading chat-md-h${level}`, role: "heading", "aria-level": level}, renderInlineMarkdown(hMatch[2])));
        i++;
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s/.test(trimLine)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
          i++;
        }
        elements.push(h("ul", {key: key++, className: "chat-md-list"},
          items.map((item, idx) => h("li", {key: idx}, renderInlineMarkdown(item)))
        ));
        continue;
      }

      // Ordered list
      if (/^\s*\d+[.)]\s/.test(trimLine)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
          i++;
        }
        elements.push(h("ol", {key: key++, className: "chat-md-list"},
          items.map((item, idx) => h("li", {key: idx}, renderInlineMarkdown(item)))
        ));
        continue;
      }

      // Regular text — collect consecutive plain lines into a paragraph
      const paraLines = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        if (!l || /^#{1,6}\s/.test(l) || /^\s*[-*+]\s/.test(l) || /^\s*\d+[.)]\s/.test(l)) break;
        paraLines.push(l);
        i++;
      }

      if (paraLines.length > 0) {
        const inlineContent = [];
        paraLines.forEach((pl, idx) => {
          if (idx > 0) inlineContent.push(h("br", {key: `br${key}-${idx}`}));
          const rendered = renderInlineMarkdown(pl);
          if (Array.isArray(rendered)) {
            inlineContent.push(...rendered);
          } else {
            inlineContent.push(rendered);
          }
        });
        elements.push(h("p", {key: key++, className: "chat-md-paragraph"}, inlineContent));
      }
    }
  }
  return elements;
}

/**
 * Top-level markdown renderer: splits fenced code blocks from the rest,
 * then delegates to renderMarkdownBlocks for prose sections.
 */
function renderMarkdown(text) {
  if (!text) return [h("span", {key: "empty"})];

  const elements = [];
  let key = 0;
  // Split by fenced code blocks (```...```)
  const codeSplit = text.split(/(```[\s\S]*?```)/g);

  for (const segment of codeSplit) {
    if (segment.startsWith("```") && segment.endsWith("```")) {
      const inner = segment.slice(3, -3);
      const nlIdx = inner.indexOf("\n");
      const code = nlIdx >= 0 ? inner.slice(nlIdx + 1).trimEnd() : inner.trimEnd();
      elements.push(
        h("pre", {key: key++, className: "chat-md-codeblock"},
          h("code", {}, code)
        )
      );
    } else if (segment.trim()) {
      const blockEls = renderMarkdownBlocks(segment, key * 1000);
      key += blockEls.length + 1;
      elements.push(...blockEls);
    }
  }

  return elements.length > 0 ? elements : [h("span", {key: "fallback"}, text)];
}

// ---------------------------------------------------------------------------
// Message parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse AI message text into segments of plain text and SQL blocks.
 * SQL blocks are wrapped in <sql>...</sql> tags by the AI.
 */
function parseMessageSegments(text) {
  if (!text) return [];
  const segments = [];
  const sqlRegex = /<sql>([\s\S]*?)<\/sql>/gi;
  let lastIndex = 0;
  let match;

  while ((match = sqlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      // Strip only leading/trailing newlines — preserve internal whitespace and paragraph breaks
      const content = text.slice(lastIndex, match.index).replace(/^\n+/, "").replace(/\n+$/, "");
      if (content) segments.push({type: "text", content});
    }
    segments.push({type: "sql", content: match[1].trim()});
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).replace(/^\n+/, "").replace(/\n+$/, "");
    if (remaining) segments.push({type: "text", content: remaining});
  }

  return segments.length > 0 ? segments : [{type: "text", content: text}];
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusStep({step}) {
  const icons = {
    "pending": h("span", {className: "chat-step-icon pending"}, "\u25CB"),
    "in-progress": h("div", {className: "chat-step-spinner"}),
    "completed": h("span", {className: "chat-step-icon completed"}, "\u2713"),
    "error": h("span", {className: "chat-step-icon error"}, "\u2717")
  };

  return h("div", {className: `chat-step chat-step-${step.status}`},
    icons[step.status] || null,
    h("span", {className: "chat-step-name"}, step.name),
    step.details && h("span", {className: "chat-step-details"}, step.details)
  );
}

class ApprovalCard extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      editing: false,
      editText: props.approval.query || ""
    };
  }

  render() {
    const {approval, onApprove, onReject, onEditAndApprove} = this.props;
    const {editing, editText} = this.state;

    if (approval.status !== "pending") {
      // Already resolved — show compact summary
      const icon = approval.status === "approved" ? "\u2713" : "\u2717";
      const label = approval.status === "approved"
        ? (approval.editedQuery ? "Approved (edited)" : "Approved")
        : "Rejected";
      return h("div", {className: `chat-approval-resolved chat-approval-${approval.status}`},
        h("span", {className: "chat-approval-icon"}, icon),
        h("span", {}, label, ": "),
        h("span", {className: "chat-approval-purpose"}, approval.purpose)
      );
    }

    const toolLabel = approval.toolName === "execute_soql" ? "SOQL query" : "SQL query";

    return h("div", {className: "chat-approval-card"},
      h("div", {className: "chat-approval-header"},
        h("span", {className: "chat-approval-badge"}, "AI wants to run a " + toolLabel)
      ),
      h("div", {className: "chat-approval-purpose"}, approval.purpose),
      editing
        ? h("textarea", {
          className: "chat-approval-editor",
          value: editText,
          onChange: (e) => this.setState({editText: e.target.value}),
          rows: 4
        })
        : h("pre", {className: "chat-approval-query"}, approval.query),
      h("div", {className: "chat-approval-actions"},
        editing && h("button", {
          className: "slds-button slds-button_brand chat-btn-small",
          onClick: () => { onEditAndApprove(approval.id, editText); this.setState({editing: false}); }
        }, "Approve edited"),
        editing && h("button", {
          className: "slds-button slds-button_neutral chat-btn-small",
          onClick: () => this.setState({editing: false, editText: approval.query})
        }, "Cancel edit"),
        !editing && h("button", {
          className: "slds-button slds-button_brand chat-btn-small",
          onClick: () => onApprove(approval.id)
        }, "Approve"),
        !editing && h("button", {
          className: "slds-button slds-button_destructive chat-btn-small",
          onClick: () => onReject(approval.id)
        }, "Reject"),
        !editing && h("button", {
          className: "slds-button slds-button_neutral chat-btn-small",
          onClick: () => this.setState({editing: true})
        }, "Edit")
      )
    );
  }
}

function ResultConsentCard({consent, onConsent, onDecline}) {
  if (consent.status !== "pending") {
    const label = consent.status === "shared" ? "Row data shared" : "Metadata only";
    return h("div", {className: `chat-consent-resolved chat-consent-${consent.status}`},
      h("span", {}, label, ` (${consent.metadata.rowCount} rows)`)
    );
  }

  const columns = consent.columns || [];
  const rows = consent.sampleRows || [];

  return h("div", {className: "chat-consent-card"},
    h("div", {className: "chat-consent-header"},
      "Query returned ", h("strong", {}, consent.metadata.rowCount), " rows. ",
      "Share sample rows with AI?"
    ),
    h("div", {className: "chat-consent-note"}, "(First ", rows.length, " rows will be sent to the Gemini API)"),
    rows.length > 0 && h("div", {className: "chat-consent-preview"},
      h("table", {},
        h("thead", {}, h("tr", {}, columns.map((col, i) => h("th", {key: i}, col)))),
        h("tbody", {}, rows.map((row, ri) =>
          h("tr", {key: ri}, columns.map((col, ci) =>
            h("td", {key: ci}, row[col] != null ? String(row[col]) : "")
          ))
        ))
      )
    ),
    h("div", {className: "chat-consent-actions"},
      h("button", {
        className: "slds-button slds-button_brand chat-btn-small",
        onClick: () => onConsent(consent.id)
      }, "Share with AI"),
      h("button", {
        className: "slds-button slds-button_neutral chat-btn-small",
        onClick: () => onDecline(consent.id)
      }, "Metadata only")
    )
  );
}

function UserMessage({msg}) {
  return h("div", {className: "chat-message chat-message-user"},
    h("div", {className: "chat-message-content"},
      h("div", {className: "chat-message-text"}, msg.text),
      msg.context && h("div", {className: "chat-message-context"},
        msg.context.query && h("span", {className: "chat-context-chip"}, "\uD83D\uDCCE Query"),
        msg.context.error && h("span", {className: "chat-context-chip chat-context-chip-error"}, "\uD83D\uDCCE Error"),
        msg.context.results && h("span", {className: "chat-context-chip"}, "\uD83D\uDCCE Results")
      )
    )
  );
}

function AssistantMessage({msg, onInsertQuery, onApprove, onReject, onEditAndApprove, onConsent, onDecline, onRetry}) {
  const segments = parseMessageSegments(msg.text);

  return h("div", {className: "chat-message chat-message-assistant"},
    h("div", {className: "chat-message-content"},
      // Status steps
      msg.steps.length > 0 && h("div", {className: "chat-steps"},
        msg.steps.map(step => h(StatusStep, {key: step.id, step}))
      ),

      // Approval cards
      msg.approvals.map(approval =>
        h(ApprovalCard, {
          key: approval.id,
          approval,
          onApprove,
          onReject,
          onEditAndApprove
        })
      ),

      // Result consent cards
      msg.resultConsents.map(consent =>
        h(ResultConsentCard, {
          key: consent.id,
          consent,
          onConsent,
          onDecline
        })
      ),

      // Message text with embedded SQL blocks
      segments.map((seg, i) => {
        if (seg.type === "sql") {
          return h("div", {key: i, className: "chat-sql-block"},
            h("pre", {className: "chat-sql-code"}, seg.content),
            h("button", {
              className: "slds-button slds-button_brand chat-btn-small chat-insert-btn",
              onClick: () => onInsertQuery(seg.content)
            }, "Insert Query")
          );
        }
        return seg.content ? h("div", {key: i, className: "chat-text-segment"}, ...renderMarkdown(seg.content)) : null;
      }),

      // If we extracted a query but it wasn't in <sql> tags, still show Insert
      !segments.some(s => s.type === "sql") && msg.extractedQuery && h("div", {className: "chat-sql-block"},
        h("pre", {className: "chat-sql-code"}, msg.extractedQuery),
        h("button", {
          className: "slds-button slds-button_brand chat-btn-small chat-insert-btn",
          onClick: () => onInsertQuery(msg.extractedQuery)
        }, "Insert Query")
      ),

      // Error indicator with retry button
      msg.error && h("div", {className: "chat-error-block"},
        !msg.text && h("div", {className: "chat-error-text"}, msg.error),
        msg.text && h("div", {className: "chat-error-text chat-error-text-inline"}, "Error: ", msg.error),
        onRetry && h("button", {
          className: "slds-button slds-button_neutral chat-btn-small chat-retry-btn",
          onClick: onRetry
        }, "Retry")
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Context bar: shows what will be sent with the next message
// ---------------------------------------------------------------------------

function ContextBar({currentQuery, currentError, exportedData, attachedContext, onToggleContext, onAttachResults}) {
  const hasQuery = !!currentQuery;
  const hasError = !!currentError;
  const hasResults = exportedData && exportedData.table && exportedData.table.length > 1;

  if (!hasQuery && !hasError && !hasResults) return null;

  return h("div", {className: "chat-context-bar"},
    hasQuery && h("span", {
      className: `chat-context-tag ${attachedContext.query ? "active" : "inactive"}`,
      onClick: () => onToggleContext("query"),
      title: attachedContext.query ? "Click to remove query context" : "Click to attach query context"
    },
      "\uD83D\uDCCE Query",
      attachedContext.query && h("span", {className: "chat-context-remove", onClick: (e) => { e.stopPropagation(); onToggleContext("query"); }}, "\u00D7")
    ),
    hasError && h("span", {
      className: `chat-context-tag chat-context-tag-error ${attachedContext.error ? "active" : "inactive"}`,
      onClick: () => onToggleContext("error"),
      title: attachedContext.error ? "Click to remove error context" : "Click to attach error context"
    },
      "\uD83D\uDCCE Error",
      attachedContext.error && h("span", {className: "chat-context-remove", onClick: (e) => { e.stopPropagation(); onToggleContext("error"); }}, "\u00D7")
    ),
    hasResults && !attachedContext.results && h("button", {
      className: "slds-button slds-button_neutral chat-btn-small chat-attach-results-btn",
      onClick: onAttachResults,
      title: "Attach a sample of the current results (you will preview before sending)"
    }, "+ Attach results"),
    hasResults && attachedContext.results && h("span", {
      className: "chat-context-tag active"
    },
      "\uD83D\uDCCE Results (" + attachedContext.resultRowCount + " rows)",
      h("span", {className: "chat-context-remove", onClick: () => onToggleContext("results")}, "\u00D7")
    )
  );
}

// ---------------------------------------------------------------------------
// Main ChatPanel component
// ---------------------------------------------------------------------------

/**
 * ChatPanel - Always-visible conversational AI chat drawer for the SQL Query page.
 *
 * Props:
 *  - conversationManager: ConversationManager instance
 *  - getCurrentQuery: () => string (reads current textarea value on demand)
 *  - currentError: string (last execution error)
 *  - exportedData: ResultTable (last query results)
 *  - onInsertQuery: (queryText) => void
 */
export default class ChatPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      inputText: "",
      attachedContext: {
        query: true,  // auto-attached by default
        error: true,  // auto-attached by default
        results: false, // requires explicit opt-in
        resultRowCount: 0,
        resultData: null
      },
      showResultsPreview: false
    };
    this.onSend = this.onSend.bind(this);
    this.onInputKeyDown = this.onInputKeyDown.bind(this);
    this.onToggleContext = this.onToggleContext.bind(this);
    this.onAttachResults = this.onAttachResults.bind(this);
    this.onConfirmAttachResults = this.onConfirmAttachResults.bind(this);
    this.onCancelAttachResults = this.onCancelAttachResults.bind(this);
    this.messagesEndRef = null;
    this.messagesContainerRef = null;
    this.inputRef = null;
    this._setMessagesEndRef = (el) => { this.messagesEndRef = el; };
    this._setMessagesContainerRef = (el) => { this.messagesContainerRef = el; };
    this._setInputRef = (el) => { this.inputRef = el; };
    this._userIsNearBottom = true;
    this._lastScrollFingerprint = "";
  }

  componentDidMount() {
    // If opened with an autoSend prompt (e.g. "Fix this error"), send it immediately
    if (this.props.autoSend && this.props.initialPrompt) {
      this._autoSendInitialPrompt(this.props.initialPrompt);
    } else if (this.props.initialPrompt && !this.state.inputText) {
      this.setState({inputText: this.props.initialPrompt});
    }
  }

  componentDidUpdate(prevProps) {
    // Auto-scroll to bottom only when messages actually changed
    const msgCount = this.props.conversationManager?.messages?.length || 0;
    const lastMsg = this.props.conversationManager?.messages?.[msgCount - 1];
    const lastMsgTextLen = lastMsg?.text?.length || 0;
    const lastMsgStepCount = lastMsg?.steps?.length || 0;
    const fingerprint = `${msgCount}:${lastMsgTextLen}:${lastMsgStepCount}`;
    if (this._lastScrollFingerprint !== fingerprint && this._userIsNearBottom && this.messagesEndRef) {
      this.messagesEndRef.scrollIntoView({behavior: "smooth"});
      this._lastScrollFingerprint = fingerprint;
    }
    // Reset context attachment when error/query changes
    if (prevProps.currentError !== this.props.currentError && this.props.currentError) {
      this.setState(prev => ({attachedContext: {...prev.attachedContext, error: true}}));
    }
    // If autoSend + initialPrompt changed, auto-send it
    if (this.props.autoSend && this.props.initialPrompt && this.props.initialPrompt !== prevProps.initialPrompt) {
      this._autoSendInitialPrompt(this.props.initialPrompt);
    } else if (!this.props.autoSend && this.props.initialPrompt && this.props.initialPrompt !== prevProps.initialPrompt) {
      this.setState({inputText: this.props.initialPrompt});
    }
  }

  _autoSendInitialPrompt(promptText) {
    const {conversationManager, getCurrentQuery, currentError} = this.props;
    if (!conversationManager || conversationManager.isProcessing) {
      // Fall back to populating the input if we can't auto-send right now
      this.setState({inputText: promptText});
      return;
    }
    const currentQuery = typeof getCurrentQuery === "function" ? getCurrentQuery() : "";
    const context = {};
    if (currentQuery) context.query = currentQuery;
    if (currentError) context.error = currentError;
    conversationManager.sendMessage(promptText.trim(), Object.keys(context).length > 0 ? context : null);
  }

  _onMessagesScroll() {
    const el = this.messagesContainerRef;
    if (!el) return;
    // Consider "near bottom" if within 60px of the scrollable bottom
    this._userIsNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
  }

  _autoResizeInput() {
    const el = this.inputRef;
    if (!el) return;
    el.style.height = "auto";
    // Clamp between 1-row min and ~6 rows max
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }

  onSend() {
    const {conversationManager, getCurrentQuery, currentError} = this.props;
    const currentQuery = typeof getCurrentQuery === "function" ? getCurrentQuery() : "";
    const {inputText, attachedContext} = this.state;
    if (!inputText.trim() || conversationManager.isProcessing) return;

    const context = {};
    if (attachedContext.query && currentQuery) context.query = currentQuery;
    if (attachedContext.error && currentError) context.error = currentError;
    if (attachedContext.results && attachedContext.resultData) context.results = attachedContext.resultData;

    conversationManager.sendMessage(inputText.trim(), Object.keys(context).length > 0 ? context : null);

    this.setState({
      inputText: "",
      attachedContext: {
        query: true,
        error: !!currentError,
        results: false,
        resultRowCount: 0,
        resultData: null
      }
    }, () => this._autoResizeInput());
  }

  onInputKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.onSend();
    }
  }

  onToggleContext(key) {
    this.setState(prev => ({
      attachedContext: {
        ...prev.attachedContext,
        [key]: !prev.attachedContext[key],
        ...(key === "results" ? {resultData: null, resultRowCount: 0} : {})
      }
    }));
  }

  onAttachResults() {
    this.setState({showResultsPreview: true});
  }

  onConfirmAttachResults() {
    const {exportedData} = this.props;
    if (!exportedData || !exportedData.table || exportedData.table.length <= 1) return;

    const headers = exportedData.table[0];
    const rows = exportedData.table.slice(1, 6); // First 5 data rows
    const csvText = [headers.join(", "), ...rows.map(r => r.map(c => c != null ? String(c) : "").join(", "))].join("\n");

    this.setState(prev => ({
      showResultsPreview: false,
      attachedContext: {
        ...prev.attachedContext,
        results: true,
        resultRowCount: Math.min(5, exportedData.table.length - 1),
        resultData: csvText
      }
    }));
  }

  onCancelAttachResults() {
    this.setState({showResultsPreview: false});
  }

  render() {
    const {conversationManager, getCurrentQuery, currentError, exportedData, onInsertQuery} = this.props;
    if (!conversationManager) return null;
    const currentQuery = typeof getCurrentQuery === "function" ? getCurrentQuery() : "";

    const {inputText, attachedContext, showResultsPreview} = this.state;
    const messages = conversationManager.messages;
    const isProcessing = conversationManager.isProcessing;

    return h("div", {className: "chat-panel"},
      // Header
      h("div", {className: "chat-header"},
        h("span", {className: "chat-header-title"}, "AI Chat"),
        h("div", {className: "chat-header-controls"},
          // Auto-mode toggle
          h("label", {className: "chat-auto-toggle", title: "Auto-mode: AI can execute queries without asking for approval each time"},
            h("input", {
              type: "checkbox",
              checked: conversationManager.autoMode,
              onChange: (e) => conversationManager.setAutoMode(e.target.checked)
            }),
            " Auto"
          ),
          // Auto-share rows sub-toggle (only visible when auto-mode is on)
          conversationManager.autoMode && h("label", {className: "chat-auto-toggle", title: "Auto-share row samples with AI when queries execute in auto-mode"},
            h("input", {
              type: "checkbox",
              checked: conversationManager.autoShareRows,
              onChange: (e) => conversationManager.setAutoShareRows(e.target.checked)
            }),
            " Share rows"
          ),
          // Budget display
          (conversationManager.sessionQueryCount > 0 || conversationManager.autoMode) &&
            h("span", {className: "chat-budget"},
              `Queries: ${conversationManager.turnQueryCount}/${conversationManager.turnQueryLimit} turn`,
              ` \u00B7 ${conversationManager.sessionQueryCount} total`
            ),
          // New conversation
          h("button", {
            className: "slds-button slds-button_neutral chat-btn-small",
            onClick: () => conversationManager.resetConversation(),
            disabled: isProcessing,
            title: "Start a new conversation"
          }, "New"),
          // (drawer is always visible — no close button needed)
        )
      ),

      // Messages area
      h("div", {className: "chat-messages", ref: this._setMessagesContainerRef, onScroll: () => this._onMessagesScroll()},
        messages.length === 0 && h("div", {className: "chat-empty"},
          "Describe what you want to query. The AI will explore the schema and build a query for you."
        ),

        messages.map(msg => {
          if (msg.role === "user") {
            return h(UserMessage, {key: msg.id, msg});
          }
          // Only show retry on the last assistant message if it has an error and we're not processing
          const isLastAssistant = msg === messages[messages.length - 1] && msg.error && !isProcessing;
          return h(AssistantMessage, {
            key: msg.id,
            msg,
            onInsertQuery,
            onApprove: (id) => conversationManager.approveExecution(id),
            onReject: (id) => conversationManager.rejectExecution(id),
            onEditAndApprove: (id, q) => conversationManager.editAndApprove(id, q),
            onConsent: (id) => conversationManager.consentToShareRows(id),
            onDecline: (id) => conversationManager.declineRowSharing(id),
            onRetry: isLastAssistant ? () => conversationManager.retryLastMessage() : null
          });
        }),

        // Processing indicator
        isProcessing && messages.length > 0 && !messages[messages.length - 1]?.steps?.some(s => s.status === "in-progress")
          && h("div", {className: "chat-thinking"}, h("div", {className: "chat-thinking-dots"},
            h("span", {}), h("span", {}), h("span", {})
          )),

        h("div", {ref: this._setMessagesEndRef})
      ),

      // Results preview modal (for attaching results)
      showResultsPreview && exportedData && exportedData.table && exportedData.table.length > 1 && h("div", {
        className: "chat-results-preview-overlay",
        onClick: (e) => { if (e.target === e.currentTarget) this.onCancelAttachResults(); }
      },
        h("div", {className: "chat-results-preview"},
          h("h4", {}, "Preview: these rows will be sent to the Gemini API"),
          h("div", {className: "chat-results-preview-table"},
            h("table", {},
              h("thead", {}, h("tr", {}, exportedData.table[0].map((col, i) => h("th", {key: i}, col)))),
              h("tbody", {}, exportedData.table.slice(1, 6).map((row, ri) =>
                h("tr", {key: ri}, row.map((cell, ci) =>
                  h("td", {key: ci}, cell != null ? String(cell).substring(0, 50) : "")
                ))
              ))
            )
          ),
          h("div", {className: "chat-results-preview-actions"},
            h("button", {className: "slds-button slds-button_brand", onClick: this.onConfirmAttachResults}, "Attach"),
            h("button", {className: "slds-button slds-button_neutral", onClick: this.onCancelAttachResults}, "Cancel")
          )
        )
      ),

      // Context bar
      h(ContextBar, {
        currentQuery,
        currentError,
        exportedData,
        attachedContext,
        onToggleContext: this.onToggleContext,
        onAttachResults: this.onAttachResults
      }),

      // Input bar
      h("div", {className: "chat-input-bar"},
        h("textarea", {
          className: "chat-input",
          ref: this._setInputRef,
          value: inputText,
          onChange: (e) => { this.setState({inputText: e.target.value}, () => this._autoResizeInput()); },
          onKeyDown: this.onInputKeyDown,
          placeholder: messages.length === 0
            ? "e.g. accounts with their open opportunities where industry is tech"
            : "Follow up or refine...",
          rows: 1,
          disabled: isProcessing
        }),
        h("button", {
          className: "slds-button slds-button_brand chat-send-btn",
          onClick: this.onSend,
          disabled: !inputText.trim() || isProcessing
        }, isProcessing ? "..." : "Send")
      )
    );
  }
}
