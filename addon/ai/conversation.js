import {getGeminiConfig, geminiGenerateWithTools, extractQueryFromResponse} from "./gemini.js";
import {fetchSObjectNames, suggestSObjectsFromPrompt, fetchSObjectDescribe, serializeSObjectDescribe} from "./schema.js";
import {buildConversationalSystemInstruction} from "./prompts.js";

let _idCounter = 0;
function nextId(prefix) { return (prefix || "id") + "_" + (++_idCounter); }

/**
 * Tool declarations sent to Gemini for function calling.
 * Schema tools (search_objects, get_object_schema) execute without user approval.
 * Execution tools (execute_soql, execute_query) require approval unless auto-mode is on.
 */
const TOOL_DECLARATIONS = [{
  functionDeclarations: [
    {
      name: "search_objects",
      description: "Fuzzy-search the Salesforce org's queryable SObject list. Returns matching object API names. Use this to discover available objects before fetching their schema.",
      parameters: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            items: {type: "string"},
            description: "One or more search terms to match against object names and labels (e.g. ['account', 'contact'])"
          }
        },
        required: ["queries"]
      }
    },
    {
      name: "get_object_schema",
      description: "Fetch the full field list for one or more Salesforce objects. Returns field names, types, lengths, and referenceTo relationships. Use this to understand an object's schema before building queries.",
      parameters: {
        type: "object",
        properties: {
          object_names: {
            type: "array",
            items: {type: "string"},
            description: "Exact API names of the SObjects to describe (e.g. ['Account', 'Contact'])"
          }
        },
        required: ["object_names"]
      }
    },
    {
      name: "execute_soql",
      description: "Execute a single SOQL query against Salesforce and return result metadata (row count, columns). Use this sparingly to test individual CTEs, check data existence, or validate join columns. Every call costs org API limits.",
      parameters: {
        type: "object",
        properties: {
          soql: {type: "string", description: "The SOQL query to execute"},
          purpose: {type: "string", description: "Brief explanation of WHY you want to run this query (shown to the user for approval)"}
        },
        required: ["soql", "purpose"]
      }
    },
    {
      name: "execute_query",
      description: "Execute a full SQL-with-CTEs query through the complete pipeline (SOQL extraction, Salesforce fetch, SQLite load, final SQL execution). Returns result metadata. Costs multiple API calls (one per CTE). Use only when you need to test the assembled query end-to-end.",
      parameters: {
        type: "object",
        properties: {
          sql: {type: "string", description: "The full SQL query with CTEs and SOQL magic comments"},
          purpose: {type: "string", description: "Brief explanation of WHY you want to run this query (shown to the user for approval)"}
        },
        required: ["sql", "purpose"]
      }
    }
  ]
}];

function isExecTool(name) {
  return name === "execute_soql" || name === "execute_query";
}

// Maximum function-call loop iterations per sendMessage (safety limit)
const MAX_LOOP_ITERATIONS = 20;

// Default rough character limit for conversation pruning (~80K tokens * 4 chars/token)
const DEFAULT_PRUNE_CHAR_LIMIT = 300000;

/**
 * ConversationManager — step-based state machine
 *
 * Manages a multi-turn Gemini conversation with function calling.
 * Instead of a long-running async loop with suspended Promise contexts,
 * uses an explicit phase field and a short-lived _advance() method that
 * processes one phase at a time and returns when user input is needed.
 *
 * Phases:
 *   idle             — waiting for user input
 *   calling-api      — about to call / currently calling Gemini
 *   handling-tools   — processing function-call results from last API response
 *   awaiting-approval — paused, waiting for user to approve/reject a query
 *   awaiting-consent  — paused, waiting for user to share/decline row data
 *
 * External events (approve, reject, consent, decline, reset) mutate state
 * and re-enter _advance() — there is never a suspended async context to
 * invalidate, so reset/retry are trivial.
 */
export class ConversationManager {
  constructor({sfConn, useToolingApi, executeSoqlCallback, executeQueryCallback, onChange, pruneCharLimit}) {
    this.sfConn = sfConn || null;
    this.useToolingApi = useToolingApi || false;
    this.executeSoqlCallback = executeSoqlCallback;
    this.executeQueryCallback = executeQueryCallback;
    this.onChange = onChange || (() => {});
    this.pruneCharLimit = pruneCharLimit || DEFAULT_PRUNE_CHAR_LIMIT;

    /** @type {Array} Gemini API contents history */
    this.contents = [];

    /** @type {Array} UI display messages */
    this.messages = [];

    /** Auto-mode: skip approval for execution tools */
    this.autoMode = false;

    /** Auto-share row samples in auto-mode */
    this.autoShareRows = false;

    /** Per-turn query execution counter (resets each sendMessage) */
    this.turnQueryCount = 0;

    /** Session-wide query execution counter */
    this.sessionQueryCount = 0;

    /** Max queries per turn in auto-mode */
    this.turnQueryLimit = 5;

    /**
     * Current phase of the state machine.
     * @type {"idle"|"calling-api"|"handling-tools"|"awaiting-approval"|"awaiting-consent"}
     */
    this._phase = "idle";

    /**
     * Active turn state — null when idle. Holds all mutable state for the
     * current assistant response being built. Used as an identity token to
     * detect stale _advance() calls after reset.
     */
    this._turn = null;

    /** Cached SObject names list (fetched once per conversation) */
    this._cachedSObjectNames = null;

    /** Last sent user message info for retry support */
    this._lastUserMessage = null;
  }

  get isProcessing() { return this._phase !== "idle"; }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Send a user message (with optional context) and start the AI response loop.
   */
  async sendMessage(text, context) {
    if (this._phase !== "idle") return;

    // Build the full text with context appended
    let contextSuffix = "";
    if (context?.query) contextSuffix += "\n\n[Current query]\n" + context.query;
    if (context?.error) contextSuffix += "\n\n[Error]\n" + context.error;
    if (context?.results) contextSuffix += "\n\n[Result sample]\n" + context.results;
    const fullText = text + contextSuffix;

    // Save for retry support
    this._lastUserMessage = {text, context};

    // Add to API history
    this.contents.push({role: "user", parts: [{text: fullText}]});

    // Add to display messages
    this.messages.push({
      id: nextId("user"),
      role: "user",
      text,
      context: context || null
    });

    this._startTurn();
  }

  /**
   * Retry the last AI response. Removes the failed assistant message and
   * all intermediate turns (function-call round-trips) back to the last
   * user text message, then re-runs the turn.
   */
  async retryLastMessage() {
    if (this._phase !== "idle" || !this._lastUserMessage) return;

    // Remove the last assistant message from display
    if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === "assistant") {
      this.messages.pop();
    }

    // Remove all API history entries after the last user text message.
    // This cleanly handles intermediate model + functionResponse turns
    // that were added during the failed processing.
    this._rewindContentsToLastUserText();

    this._startTurn();
  }

  /**
   * Approve a pending query execution.
   */
  approveExecution(approvalId) {
    if (this._phase !== "awaiting-approval" || !this._turn?.currentApproval) return;
    if (this._turn.currentApproval.approval.id !== approvalId) return;

    this._turn.currentApproval.approval.status = "approved";
    this._emitChange();

    // Fire-and-forget: execute the tool asynchronously
    this._executeApprovedTool().catch(e => {
      console.error("[ConversationManager] _executeApprovedTool error:", e);
      if (this._turn) this._finishTurnWithError(e);
    });
  }

  /**
   * Reject a pending query execution.
   */
  rejectExecution(approvalId) {
    if (this._phase !== "awaiting-approval" || !this._turn?.currentApproval) return;
    if (this._turn.currentApproval.approval.id !== approvalId) return;

    const ca = this._turn.currentApproval;
    ca.approval.status = "rejected";

    this._turn.responseParts.push({
      functionResponse: {name: ca.toolName, response: {rejected: true, reason: "User declined to run this query"}}
    });
    this._turn.currentApproval = null;
    this._turn.execIndex++;
    this._phase = "handling-tools";
    this._emitChange();

    this._advance().catch(e => {
      console.error("[ConversationManager] _advance error after reject:", e);
      if (this._turn) this._finishTurnWithError(e);
    });
  }

  /**
   * Edit the query in a pending approval and then approve it.
   */
  editAndApprove(approvalId, newQuery) {
    if (this._phase !== "awaiting-approval" || !this._turn?.currentApproval) return;
    if (this._turn.currentApproval.approval.id !== approvalId) return;

    const ca = this._turn.currentApproval;
    ca.approval.editedQuery = newQuery;
    ca.approval.query = newQuery;

    // Update the tool args with the edited query
    if (ca.toolName === "execute_soql") {
      ca.args = {...ca.args, soql: newQuery};
    } else {
      ca.args = {...ca.args, sql: newQuery};
    }

    this.approveExecution(approvalId);
  }

  /**
   * Consent to share row data from a query result.
   */
  consentToShareRows(consentId) {
    if (this._phase !== "awaiting-consent" || !this._turn?.currentConsent) return;
    if (this._turn.currentConsent.consent.id !== consentId) return;

    const cc = this._turn.currentConsent;
    cc.consent.status = "shared";

    this._turn.responseParts.push({
      functionResponse: {name: cc.toolName, response: {...cc.metadata, sample: cc.sampleRows}}
    });
    this._turn.currentConsent = null;
    this._turn.execIndex++;
    this._phase = "handling-tools";
    this._emitChange();

    this._advance().catch(e => {
      console.error("[ConversationManager] _advance error after consent:", e);
      if (this._turn) this._finishTurnWithError(e);
    });
  }

  /**
   * Decline to share row data — only metadata is sent.
   */
  declineRowSharing(consentId) {
    if (this._phase !== "awaiting-consent" || !this._turn?.currentConsent) return;
    if (this._turn.currentConsent.consent.id !== consentId) return;

    const cc = this._turn.currentConsent;
    cc.consent.status = "declined";

    this._turn.responseParts.push({
      functionResponse: {name: cc.toolName, response: cc.metadata}
    });
    this._turn.currentConsent = null;
    this._turn.execIndex++;
    this._phase = "handling-tools";
    this._emitChange();

    this._advance().catch(e => {
      console.error("[ConversationManager] _advance error after decline:", e);
      if (this._turn) this._finishTurnWithError(e);
    });
  }

  setAutoMode(value) {
    this.autoMode = value;
    this._emitChange();
  }

  setAutoShareRows(value) {
    this.autoShareRows = value;
    this._emitChange();
  }

  /**
   * Reset the conversation. Because there are no suspended async contexts
   * or pending Promises, this is just a field reset — any in-flight
   * _advance() will detect the turn identity mismatch and bail.
   */
  resetConversation() {
    this._turn = null;
    this._phase = "idle";
    this.contents = [];
    this.messages = [];
    this.turnQueryCount = 0;
    this.sessionQueryCount = 0;
    this._cachedSObjectNames = null;
    this._emitChange();
  }

  // ---------------------------------------------------------------------------
  // Turn lifecycle
  // ---------------------------------------------------------------------------

  _emitChange() {
    try { this.onChange(); } catch (e) { console.error("[ConversationManager] onChange error:", e); }
  }

  /**
   * Begin a new assistant turn: create the assistant message shell,
   * initialize turn state, and start advancing.
   */
  _startTurn() {
    const assistantMsg = {
      id: nextId("ai"),
      role: "assistant",
      text: "",
      steps: [],
      approvals: [],
      resultConsents: [],
      extractedQuery: null,
      error: null
    };
    this.messages.push(assistantMsg);

    this._turn = {
      assistantMsg,
      iteration: 0,
      // Per-iteration tool processing state (reset each time we enter handling-tools from calling-api):
      schemaCallParts: [],
      execCallParts: [],
      schemasDone: false,
      execIndex: 0,
      responseParts: [],
      // Single pending approval/consent (at most one at a time):
      currentApproval: null,
      currentConsent: null,
    };
    this.turnQueryCount = 0;
    this._phase = "calling-api";
    this._emitChange();

    this._advance().catch(e => {
      console.error("[ConversationManager] _advance error:", e);
      if (this._turn) this._finishTurnWithError(e);
    });
  }

  /**
   * The state machine. Runs in a while loop, processing one phase per
   * iteration. Exits when the phase is idle or awaiting user input
   * (approval/consent). Each async boundary checks the turn identity
   * to bail if the turn was reset.
   */
  async _advance() {
    const myTurn = this._turn;

    try {
      while (true) {
        // Bail if turn was cancelled (reset or new message)
        if (this._turn !== myTurn) return;

        // Terminal states — return and wait for external event
        if (this._phase === "idle"
          || this._phase === "awaiting-approval"
          || this._phase === "awaiting-consent") {
          return;
        }

        // ----- PHASE: calling-api -----
        if (this._phase === "calling-api") {
          if (myTurn.iteration >= MAX_LOOP_ITERATIONS) {
            this._finishTurn("Reached maximum tool iterations without a final response. Please try rephrasing or simplifying your request.");
            return;
          }
          myTurn.iteration++;

          this._pruneHistoryIfNeeded();
          const {apiKey, model} = getGeminiConfig();
          const systemInstruction = buildConversationalSystemInstruction();

          const parts = await geminiGenerateWithTools({
            apiKey, model, systemInstruction,
            contents: this.contents,
            tools: TOOL_DECLARATIONS
          });

          if (this._turn !== myTurn) return;

          // Add model response to API history
          this.contents.push({role: "model", parts});

          // Separate text and function calls
          const textParts = parts.filter(p => p.text != null);
          const fnCallParts = parts.filter(p => p.functionCall);

          if (textParts.length > 0) {
            myTurn.assistantMsg.text += textParts.map(p => p.text).join("");
            this._emitChange();
          }

          if (fnCallParts.length === 0) {
            // Pure text response — turn is complete
            this._finishTurn();
            return;
          }

          // Set up tool processing for this iteration
          myTurn.schemaCallParts = fnCallParts.filter(p => !isExecTool(p.functionCall.name));
          myTurn.execCallParts = fnCallParts.filter(p => isExecTool(p.functionCall.name));
          myTurn.schemasDone = false;
          myTurn.execIndex = 0;
          myTurn.responseParts = [];

          this._phase = "handling-tools";
          continue;
        }

        // ----- PHASE: handling-tools -----
        if (this._phase === "handling-tools") {

          // Step 1: Run all schema tools concurrently (no approval needed)
          if (!myTurn.schemasDone) {
            if (myTurn.schemaCallParts.length > 0) {
              const results = await Promise.all(
                myTurn.schemaCallParts.map(part => this._runSchemaTool(myTurn.assistantMsg, part))
              );
              if (this._turn !== myTurn) return;
              for (const r of results) {
                myTurn.responseParts.push({functionResponse: {name: r.name, response: r.response}});
              }
            }
            myTurn.schemasDone = true;
          }

          // Step 2: Process the next execution tool
          if (myTurn.execIndex < myTurn.execCallParts.length) {
            const part = myTurn.execCallParts[myTurn.execIndex];
            const {name, args} = part.functionCall;
            const purpose = args.purpose || "Run query";

            // Budget check
            if (this.autoMode && this.turnQueryCount >= this.turnQueryLimit) {
              myTurn.responseParts.push({
                functionResponse: {name, response: {rejected: true, reason: `Turn query limit reached (${this.turnQueryLimit}). Ask the user to approve further queries.`}}
              });
              myTurn.execIndex++;
              continue;
            }

            if (this.autoMode) {
              // Auto-execute without approval
              const stepIdx = this._addStep(myTurn.assistantMsg, `Executing: ${purpose}`, "in-progress");
              try {
                const result = await this._executeToolCallback(name, args);
                if (this._turn !== myTurn) return;
                this.turnQueryCount++;
                this.sessionQueryCount++;

                if (result.success) {
                  this._updateStep(myTurn.assistantMsg, stepIdx, "completed", `${result.rowCount} rows`);
                  myTurn.responseParts.push({
                    functionResponse: {name, response: this._buildResultResponse(result)}
                  });
                } else {
                  this._updateStep(myTurn.assistantMsg, stepIdx, "error", result.error);
                  myTurn.responseParts.push({functionResponse: {name, response: result}});
                }
              } catch (e) {
                if (this._turn !== myTurn) return;
                this._updateStep(myTurn.assistantMsg, stepIdx, "error", e.message);
                myTurn.responseParts.push({
                  functionResponse: {name, response: {success: false, error: e.message}}
                });
              }
              myTurn.execIndex++;
              this._emitChange();
              continue;
            }

            // Manual approval required — pause and wait for user
            this._setupApproval(myTurn, name, args, purpose);
            this._phase = "awaiting-approval";
            this._emitChange();
            return;
          }

          // Step 3: All tools processed — send responses back to Gemini
          this.contents.push({role: "user", parts: myTurn.responseParts});
          this._phase = "calling-api";
          this._emitChange();
          continue;
        }
      }
    } catch (e) {
      if (this._turn !== myTurn) return;
      this._finishTurnWithError(e);
    }
  }

  /**
   * Complete the current turn normally.
   */
  _finishTurn(errorMsg) {
    if (!this._turn) return;
    const msg = this._turn.assistantMsg;
    if (errorMsg) {
      if (!msg.text) msg.text = errorMsg;
      msg.error = errorMsg;
    }
    msg.extractedQuery = this._extractQuery(msg.text);
    this._turn = null;
    this._phase = "idle";
    this._emitChange();
  }

  /**
   * Complete the current turn with an error.
   */
  _finishTurnWithError(e) {
    if (!this._turn) return;
    const msg = this._turn.assistantMsg;
    const errText = e.message || String(e);
    if (!msg.text) {
      msg.text = "Error: " + errText;
    }
    msg.error = errText;
    msg.extractedQuery = this._extractQuery(msg.text);
    this._turn = null;
    this._phase = "idle";
    this._emitChange();
  }

  /**
   * Rewind contents[] to just after the last user turn that contains a
   * text part. This removes all intermediate model turns and function-
   * response turns from a failed processing attempt, making retry safe.
   */
  _rewindContentsToLastUserText() {
    for (let i = this.contents.length - 1; i >= 0; i--) {
      const entry = this.contents[i];
      if (entry.role === "user" && (entry.parts || []).some(p => p.text != null)) {
        this.contents = this.contents.slice(0, i + 1);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tool execution
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a single schema tool call (search_objects or get_object_schema).
   * Returns {name, response} — never throws.
   */
  async _runSchemaTool(assistantMsg, part) {
    const {name, args} = part.functionCall;
    try {
      if (name === "search_objects") {
        return {name, response: await this._handleSearchObjects(assistantMsg, args)};
      } else if (name === "get_object_schema") {
        return {name, response: await this._handleGetObjectSchema(assistantMsg, args)};
      }
      return {name, response: {error: `Unknown tool: ${name}`}};
    } catch (e) {
      return {name, response: {error: e.message || String(e)}};
    }
  }

  async _handleSearchObjects(assistantMsg, args) {
    const queries = args.queries || [];
    const stepIdx = this._addStep(assistantMsg, `Searching objects: ${queries.join(", ")}`, "in-progress");

    try {
      if (!this._cachedSObjectNames) {
        this._cachedSObjectNames = await fetchSObjectNames({useToolingApi: this.useToolingApi, conn: this.sfConn});
      }
      const allObjects = this._cachedSObjectNames;
      const results = new Set();
      for (const query of queries) {
        const matches = suggestSObjectsFromPrompt(query, allObjects, 10);
        for (const m of matches) results.add(m.name);
      }
      const resultArray = Array.from(results);
      const preview = resultArray.slice(0, 6).join(", ") + (resultArray.length > 6 ? "..." : "");
      this._updateStep(assistantMsg, stepIdx, "completed", `Found: ${preview}`);
      return {results: resultArray};
    } catch (e) {
      this._updateStep(assistantMsg, stepIdx, "error", e.message);
      return {error: e.message};
    }
  }

  async _handleGetObjectSchema(assistantMsg, args) {
    const objectNames = args.object_names || [];
    const stepIdx = this._addStep(assistantMsg, `Fetching schema: ${objectNames.join(", ")}`, "in-progress");

    try {
      const schemas = {};
      await Promise.all(objectNames.map(async (name) => {
        try {
          const describe = await fetchSObjectDescribe({sobjectName: name, useToolingApi: this.useToolingApi, conn: this.sfConn});
          schemas[name] = serializeSObjectDescribe(name, describe);
        } catch (e) {
          schemas[name] = `Error describing ${name}: ${e.message}`;
        }
      }));

      const details = objectNames.map(n => {
        const val = schemas[n] || "";
        if (typeof val === "string" && val.startsWith("Error")) {
          return `${n} (error)`;
        }
        const fieldCount = val.split("\n").length - 1;
        return `${n} (${fieldCount} fields)`;
      }).join(", ");
      this._updateStep(assistantMsg, stepIdx, "completed", details);
      return {schemas};
    } catch (e) {
      this._updateStep(assistantMsg, stepIdx, "error", e.message);
      return {error: e.message};
    }
  }

  /**
   * Execute the currently-approved tool. Called from approveExecution().
   * Handles result consent flow if needed, then resumes _advance().
   */
  async _executeApprovedTool() {
    const myTurn = this._turn;
    if (!myTurn?.currentApproval) return;

    const ca = myTurn.currentApproval;
    const stepIdx = this._addStep(myTurn.assistantMsg, `Executing: ${ca.approval.purpose}`, "in-progress");

    try {
      const result = await this._executeToolCallback(ca.toolName, ca.args);
      if (this._turn !== myTurn) return;
      this.turnQueryCount++;
      this.sessionQueryCount++;

      if (result.success) {
        this._updateStep(myTurn.assistantMsg, stepIdx, "completed", `${result.rowCount} rows`);

        // Check if result consent is needed (manual mode + rows + not auto-sharing)
        if (result._rows?.length > 0 && !this.autoShareRows) {
          this._setupConsent(myTurn, ca.toolName, result);
          myTurn.currentApproval = null;
          this._phase = "awaiting-consent";
          this._emitChange();
          return; // Wait for user consent/decline
        }

        // No consent needed — include result and continue
        myTurn.responseParts.push({
          functionResponse: {name: ca.toolName, response: this._buildResultResponse(result)}
        });
      } else {
        this._updateStep(myTurn.assistantMsg, stepIdx, "error", result.error);
        myTurn.responseParts.push({
          functionResponse: {name: ca.toolName, response: result}
        });
      }
    } catch (e) {
      if (this._turn !== myTurn) return;
      this._updateStep(myTurn.assistantMsg, stepIdx, "error", e.message);
      myTurn.responseParts.push({
        functionResponse: {name: ca.toolName, response: {success: false, error: e.message}}
      });
    }

    // Advance to next tool
    myTurn.currentApproval = null;
    myTurn.execIndex++;
    this._phase = "handling-tools";
    this._emitChange();

    await this._advance();
  }

  async _executeToolCallback(toolName, args) {
    if (toolName === "execute_soql") {
      return await this.executeSoqlCallback(args.soql);
    } else if (toolName === "execute_query") {
      return await this.executeQueryCallback(args.sql);
    }
    throw new Error("Unknown execution tool: " + toolName);
  }

  /**
   * Create an approval card on the assistant message and store the
   * pending approval data in the turn state.
   */
  _setupApproval(turn, toolName, args, purpose) {
    const query = toolName === "execute_soql" ? args.soql : args.sql;
    const approvalId = nextId("approval");
    const approval = {
      id: approvalId,
      toolName,
      query,
      purpose,
      status: "pending",
      editedQuery: null
    };
    turn.assistantMsg.approvals.push(approval);
    turn.currentApproval = {toolName, args, approval};
  }

  /**
   * Create a consent card on the assistant message and store the
   * pending consent data in the turn state.
   */
  _setupConsent(turn, toolName, rawResult) {
    const consentId = nextId("consent");
    const sampleRows = rawResult._rows.slice(0, 5);
    const {_rows, ...metadata} = rawResult;

    const consent = {
      id: consentId,
      metadata,
      sampleRows,
      columns: rawResult.columns,
      status: "pending"
    };
    turn.assistantMsg.resultConsents.push(consent);
    turn.currentConsent = {toolName, metadata, sampleRows, consent};
  }

  /**
   * Build the response sent back to Gemini from a query result.
   * Strips internal _rows field. Includes sample rows if autoShareRows is on.
   */
  _buildResultResponse(rawResult) {
    if (!rawResult.success) return rawResult;
    const {_rows, ...metadata} = rawResult;
    if (this.autoShareRows && _rows && _rows.length > 0) {
      return {...metadata, sample: _rows.slice(0, 5)};
    }
    return metadata;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _addStep(msg, name, status) {
    const idx = msg.steps.length;
    msg.steps.push({id: nextId("step"), name, status, details: ""});
    this._emitChange();
    return idx;
  }

  _updateStep(msg, idx, status, details) {
    if (msg.steps[idx]) {
      msg.steps[idx].status = status;
      msg.steps[idx].details = details || "";
    }
    this._emitChange();
  }

  _extractQuery(text) {
    if (!text) return null;
    const extracted = extractQueryFromResponse(text, {kind: "sql"});
    if (!extracted) return null;
    if (/^WITH\s/i.test(extracted) || /^SELECT\s/i.test(extracted)) {
      return extracted;
    }
    return null;
  }

  /**
   * Simple conversation pruning: if the total character count of contents
   * exceeds the limit, summarize older function-call exchanges.
   */
  _pruneHistoryIfNeeded() {
    const totalChars = this.contents.reduce((sum, c) => {
      return sum + (c.parts || []).reduce((s, p) => {
        if (p.text) return s + p.text.length;
        if (p.functionCall) return s + JSON.stringify(p.functionCall).length;
        if (p.functionResponse) return s + JSON.stringify(p.functionResponse).length;
        return s;
      }, 0);
    }, 0);

    if (totalChars <= this.pruneCharLimit) return;

    // Keep the first user message and the last ~10 entries.
    // Replace everything in between with a summary.
    const keepStart = 1;
    const minKeepEnd = 10;

    if (this.contents.length <= keepStart + minKeepEnd + 1) return;

    // Find a clean cut point for the tail: avoid starting with an orphaned
    // functionResponse (role=user with only functionResponse parts).
    let tailStart = this.contents.length - minKeepEnd;
    while (tailStart > keepStart + 1) {
      const entry = this.contents[tailStart];
      const hasFunctionResponse = (entry.parts || []).some(p => p.functionResponse);
      const hasText = (entry.parts || []).some(p => p.text != null);
      if (entry.role === "user" && hasFunctionResponse && !hasText) {
        tailStart--;
      } else {
        break;
      }
    }

    const toSummarize = this.contents.slice(keepStart, tailStart);

    // Build a summary of the pruned turns
    const schemasFetched = new Set();
    const schemaFieldCounts = {};
    const objectsSearched = new Set();
    let queriesExecuted = 0;
    let lastQueryRowCount = null;

    for (const entry of toSummarize) {
      for (const p of (entry.parts || [])) {
        if (p.functionCall?.name === "search_objects") {
          for (const q of (p.functionCall.args?.queries || [])) objectsSearched.add(q);
        }
        if (p.functionCall?.name === "get_object_schema") {
          for (const n of (p.functionCall.args?.object_names || [])) schemasFetched.add(n);
        }
        if (p.functionResponse?.name === "get_object_schema") {
          const schemas = p.functionResponse.response?.schemas || {};
          for (const [name, text] of Object.entries(schemas)) {
            if (typeof text === "string" && !text.startsWith("Error")) {
              schemaFieldCounts[name] = Math.max(text.split("\n").length - 1, 0);
            }
          }
        }
        if (p.functionCall?.name === "execute_soql" || p.functionCall?.name === "execute_query") {
          queriesExecuted++;
        }
        if (p.functionResponse?.name === "execute_soql" || p.functionResponse?.name === "execute_query") {
          const resp = p.functionResponse.response || {};
          if (resp.rowCount != null) lastQueryRowCount = resp.rowCount;
        }
      }
    }

    const summaryParts = [];
    if (objectsSearched.size > 0) summaryParts.push("Searched for: " + Array.from(objectsSearched).join(", "));
    if (schemasFetched.size > 0) {
      const schemaDetails = Array.from(schemasFetched).map(n => {
        const count = schemaFieldCounts[n];
        return count != null ? `${n} (${count} fields)` : n;
      }).join(", ");
      summaryParts.push("Fetched schemas: " + schemaDetails);
    }
    if (queriesExecuted > 0) {
      let queryNote = `Executed ${queriesExecuted} test queries`;
      if (lastQueryRowCount != null) queryNote += ` (last result: ${lastQueryRowCount} rows)`;
      summaryParts.push(queryNote);
    }

    const summaryText = "[Conversation history condensed]\n" + (summaryParts.join("\n") || "Previous tool interactions omitted for brevity.");

    const keptTail = this.contents.slice(tailStart);

    // Gemini API requires strictly alternating user/model turns.
    const tailStartRole = keptTail[0]?.role;
    let bridgeEntries;
    if (tailStartRole === "model") {
      bridgeEntries = [
        {role: "model", parts: [{text: summaryText}]},
        {role: "user", parts: [{text: "[Continuing conversation]"}]}
      ];
    } else {
      bridgeEntries = [
        {role: "model", parts: [{text: summaryText}]}
      ];
    }

    this.contents = [
      ...this.contents.slice(0, keepStart),
      ...bridgeEntries,
      ...keptTail
    ];
  }
}
