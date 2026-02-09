/* global React ReactDOM */
import {sfConn, apiVersion} from "./inspector.js";
import {nullToEmptyString, UserInfoModel, createSpinForMethod, copyToClipboard, downloadCsvFile} from "./utils.js";
/* global initButton */
import {initScrollTable, s} from "./data-load.js";
import {PageHeader} from "./components/PageHeader.js";
import {parseQuery} from "./lib/sql-parser.js";
import ChatPanel from "./components/ChatPanel.js";
import {isGeminiEnabled} from "./ai/gemini.js";
import {ConversationManager} from "./ai/conversation.js";

/**
 * Flatten a Salesforce record: converts nested related objects to dot-notation
 * columns and skips sub-query results ({totalSize, done, records}).
 */
function flattenRecord(obj, prefix = "", result = {}) {
  for (const key in obj) {
    if (key === "attributes") continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value === null || value === undefined || typeof value !== "object") {
      result[fullKey] = value;
    } else if (Array.isArray(value)) {
      // Array value (e.g. multi-select picklist) – store as-is
      result[fullKey] = value;
    } else if ("records" in value && "totalSize" in value) {
      // Sub-query result – cannot flatten meaningfully, skip
      continue;
    } else {
      // Nested / related object – recurse
      flattenRecord(value, fullKey, result);
    }
  }
  return result;
}

/**
 * SQLiteManager - Manages in-browser SQL database using AlaSQL in a sandboxed iframe.
 * 
 * AlaSQL uses eval() internally, which is blocked by the extension's Content Security
 * Policy (MV3: script-src 'self'). To work around this, AlaSQL runs inside a sandboxed
 * iframe (declared in manifest.json "sandbox" key) that has a relaxed CSP allowing eval.
 * All communication happens via postMessage.
 */
class SQLiteManager {
  constructor() {
    this.iframe = null;
    this.initialized = false;
    this.tables = new Set();
    this._messageId = 0;
    this._pending = new Map();
    this._onMessage = this._onMessage.bind(this);
  }

  /**
   * Handle response messages from the sandbox iframe
   */
  _onMessage(event) {
    const data = event.data;
    if (!data || data.id === undefined || !this._pending.has(data.id)) return;
    const {resolve, reject} = this._pending.get(data.id);
    this._pending.delete(data.id);
    if (data.error) {
      reject(new Error(data.error));
    } else {
      resolve(data.result);
    }
  }

  /**
   * Send a command to the sandbox iframe and return a promise for the result
   */
  _send(action, args) {
    return new Promise((resolve, reject) => {
      const id = this._messageId++;
      this._pending.set(id, {resolve, reject});
      this.iframe.contentWindow.postMessage({id, action, args}, "*");
    });
  }

  /**
   * Initialize AlaSQL by loading the sandboxed iframe
   */
  async init() {
    if (this.initialized) {
      return;
    }

    return new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.src = chrome.runtime.getURL("alasql-sandbox.html");
      iframe.style.display = "none";

      let settled = false;

      const onReady = (event) => {
        if (event.data?.type === "alasql-ready" && !settled) {
          settled = true;
          window.removeEventListener("message", onReady);
          this.iframe = iframe;
          this.initialized = true;
          window.addEventListener("message", this._onMessage);
          resolve();
        }
      };

      window.addEventListener("message", onReady);

      iframe.onerror = () => {
        if (!settled) {
          settled = true;
          window.removeEventListener("message", onReady);
          reject(new Error("Failed to load AlaSQL sandbox iframe"));
        }
      };

      document.body.appendChild(iframe);

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!settled) {
          settled = true;
          window.removeEventListener("message", onReady);
          reject(new Error("AlaSQL sandbox load timeout"));
        }
      }, 10000);
    });
  }

  /**
   * Reset the database (drop all tables)
   */
  async reset() {
    for (const table of this.tables) {
      try {
        await this._send("dropTable", {name: table});
      } catch (e) {
        // Ignore errors when dropping tables
      }
    }
    this.tables.clear();
  }

  /**
   * Create a table from Salesforce records.
   * Records are flattened locally, then sent to the sandbox in chunks for
   * table creation + bulk insertion.
   * 
   * @param {string} tableName - Name of the table to create
   * @param {Array} records - Array of Salesforce records
   * @returns {Promise<{columns: Array, rowCount: number}>}
   */
  async createTableFromRecords(tableName, records) {
    if (!records || records.length === 0) {
      await this._send("loadTable", {name: tableName, columns: [], records: [], replace: true});
      this.tables.add(tableName);
      return {columns: [], rowCount: 0};
    }

    // Flatten records (convert nested objects to dot notation columns)
    const flattenedRecords = records.map(record => flattenRecord(record));

    // Discover all columns
    const columnSet = new Set();
    for (const record of flattenedRecords) {
      for (const key of Object.keys(record)) {
        columnSet.add(key);
      }
    }

    const columns = Array.from(columnSet);

    if (columns.length === 0) {
      await this._send("loadTable", {name: tableName, columns: [], records: [], replace: true});
      this.tables.add(tableName);
      return {columns: [], rowCount: 0};
    }

    // Normalize records so each has all columns
    const normalizedRecords = flattenedRecords.map(record => {
      const normalized = {};
      for (const col of columns) {
        normalized[col] = record[col] !== undefined ? record[col] : null;
      }
      return normalized;
    });

    // Send to sandbox in chunks to avoid postMessage serialization bottlenecks
    const CHUNK_SIZE = 5000;
    for (let i = 0; i < normalizedRecords.length; i += CHUNK_SIZE) {
      const chunk = normalizedRecords.slice(i, i + CHUNK_SIZE);
      await this._send("loadTable", {
        name: tableName,
        columns,
        records: chunk,
        replace: i === 0 // first chunk creates the table; subsequent chunks append
      });
    }

    this.tables.add(tableName);
    return {columns, rowCount: normalizedRecords.length};
  }

  /**
   * Execute a SQL query and return results
   * @param {string} sql - The SQL query to execute
   * @returns {Promise<{columns: Array, values: Array}>}
   */
  async executeQuery(sql) {
    const results = await this._send("exec", {sql});

    if (!results || results.length === 0) {
      return {columns: [], values: []};
    }

    // Get columns from first result
    const columns = Object.keys(results[0]);

    // Convert to array of arrays
    const values = results.map(row => columns.map(col => row[col]));

    return {columns, values};
  }

  /**
   * Get list of tables in the database
   */
  getTables() {
    return Array.from(this.tables);
  }
}

/**
 * Query History for SQL queries
 */
class QueryHistory {
  constructor(storageKey, max) {
    this.storageKey = storageKey;
    this.max = max;
    this.list = this._get();
  }

  _get() {
    let history;
    try {
      const storedValue = localStorage.getItem(this.storageKey);
      history = storedValue ? JSON.parse(storedValue) : null;
    } catch (e) {
      console.error(e);
    }
    if (!Array.isArray(history)) {
      history = [];
    }
    return history;
  }

  add(entry) {
    let history = this._get();
    let historyIndex = history.findIndex(e => e.query === entry.query);
    if (historyIndex > -1) {
      history.splice(historyIndex, 1);
    }
    history.splice(0, 0, entry);
    if (history.length > this.max) {
      history.pop();
    }
    localStorage[this.storageKey] = JSON.stringify(history);
    this.list = history;
  }

  remove(entry) {
    let history = this._get();
    let historyIndex = history.findIndex(e => e.query === entry.query);
    if (historyIndex > -1) {
      history.splice(historyIndex, 1);
    }
    localStorage[this.storageKey] = JSON.stringify(history);
    this.list = history;
  }

  clear() {
    localStorage.removeItem(this.storageKey);
    this.list = [];
  }
}

/**
 * ResultTable - Processes and stores query results for display
 */
function ResultTable() {
  let header = [];
  let table = [];
  let rowVisibilities = [];

  function cellToString(cell) {
    if (cell === null || cell === undefined) {
      return "";
    }
    return String(cell);
  }

  let rt = {
    records: [],
    table: [],
    rowVisibilities: [],
    colVisibilities: [],
    totalSize: 0,

    setFromSQLiteResults(columns, values) {
      header = columns;
      table = [columns, ...values];
      rt.table = table;
      rt.records = values.map(row => {
        const record = {};
        columns.forEach((col, i) => {
          record[col] = row[i];
        });
        return record;
      });
      rt.rowVisibilities = table.map(() => true);
      rt.colVisibilities = columns.map(() => true);
      rt.totalSize = values.length;
    },

    csvSerialize(separator) {
      return rt.getVisibleTable()
        .map(row => row.map(cell => "\"" + cellToString(cell).split("\"").join("\"\"") + "\"").join(separator))
        .join("\r\n");
    },

    updateVisibility(filter) {
      if (!filter) {
        rt.rowVisibilities = rt.table.map(() => true);
        return;
      }
      const lowerFilter = filter.toLowerCase();
      rt.rowVisibilities = rt.table.map((row, i) => {
        if (i === 0) return true; // Header always visible
        return row.some(cell => cellToString(cell).toLowerCase().includes(lowerFilter));
      });
    },

    getVisibleTable() {
      return rt.table.filter((_, i) => rt.rowVisibilities[i]);
    }
  };

  return rt;
}

/**
 * Progress tracking for multi-step operations
 */
class ProgressTracker {
  constructor() {
    this.steps = [];
  }

  addStep(name) {
    this.steps.push({
      name,
      status: "pending",
      details: ""
    });
    return this.steps.length - 1;
  }

  updateStep(index, status, details = "") {
    if (this.steps[index]) {
      this.steps[index].status = status;
      this.steps[index].details = details;
    }
  }

  reset() {
    this.steps = [];
  }

  getSteps() {
    return [...this.steps];
  }
}

/**
 * Main Model class
 */
class Model {
  constructor({sfHost, args}) {
    this.sfHost = sfHost;
    this.customFaviconColor = localStorage.getItem(this.sfHost + "_customFavicon") || "";
    this.orgName = this.sfHost.split(".")[0]?.toUpperCase() || "";
    this.spinnerCount = 0;

    // Initialize spinFor method
    this.spinFor = createSpinForMethod(this);

    this.sfLink = "https://" + sfHost;
    this.showHelp = false;
    this.queryTooling = false;

    this.isWorking = false;
    this.exportStatus = "Ready";
    this.exportError = null;
    this.exportedData = null;
    this.resultsFilter = "";
    this.winInnerHeight = innerHeight;

    // Query history
    let historyNb = localStorage.getItem("numberOfSqlQueriesInHistory");
    this.queryHistory = new QueryHistory("insextSqlQueryHistory", historyNb ? historyNb : 50);
    this.selectedHistoryEntry = null;

    // Initial query
    this.initialQuery = "";
    if (args.has("query")) {
      this.initialQuery = args.get("query");
    } else if (this.queryHistory.list[0]) {
      this.initialQuery = this.queryHistory.list[0].query;
    } else {
      this.initialQuery = `-- SQL Query with SOQL data extraction
-- Use CTEs with /* SOQL: ... */ comments to extract Salesforce data

WITH accounts AS (
  /* SOQL: SELECT Id, Name, Industry FROM Account WHERE Industry != null LIMIT 100 */
  SELECT * FROM accounts
),
contacts AS (
  /* SOQL: SELECT Id, FirstName, LastName, AccountId FROM Contact LIMIT 100 */
  SELECT * FROM contacts
)
SELECT 
  a.Name AS AccountName,
  a.Industry,
  c.FirstName,
  c.LastName
FROM accounts a
LEFT JOIN contacts c ON a.Id = c.AccountId
ORDER BY a.Name`;
    }

    // User info model
    this.userInfoModel = new UserInfoModel(this.spinFor.bind(this));

    // SQLite manager
    this.sqliteManager = new SQLiteManager();
    this.sqliteReady = false;
    this.sqliteError = null;

    // SOQL result cache: Map<cacheKey, {records: Array, soql: string, tooling: boolean, timestamp: number}>
    // Avoids re-fetching data from Salesforce when the same SOQL is re-executed.
    this._soqlCache = new Map();

    // Progress tracking
    this.progressTracker = new ProgressTracker();

    // Abort controller for cancellation
    this.abortController = null;

    // Result table callback (for scroll table)
    this.resultTableCallback = null;

    // Conversation manager (initialized lazily when chat opens)
    this.conversationManager = null;

    // Dedicated SQLite instance for chat/AI diagnostic queries (avoids clobbering the user's main results)
    this._chatSqliteManager = null;
    this._chatSqliteReady = false;
  }

  /**
   * Ensure the ConversationManager is initialized.
   * Called when the chat panel is first opened.
   */
  ensureConversationManager() {
    if (this.conversationManager) {
      // Keep tooling API flag in sync
      this.conversationManager.useToolingApi = this.queryTooling;
      return;
    }

    this.conversationManager = new ConversationManager({
      sfConn,
      useToolingApi: this.queryTooling,
      executeSoqlCallback: async (soql) => this._executeSoqlForChat(soql),
      executeQueryCallback: async (sql) => this._executeQueryForChat(sql),
      onChange: () => this.didUpdate()
    });
  }

  /**
   * Execute a single SOQL query for the chat/AI.
   * Returns {success, rowCount, columns, columnTypes, _rows} or {success: false, error}.
   */
  async _executeSoqlForChat(soql) {
    try {
      const activeTurn = this.conversationManager?._turn;
      const records = [];
      let totalSize = 0;
      let endpoint = "/services/data/v" + apiVersion + (this.queryTooling ? "/tooling/query" : "/query") + "/?q=" + encodeURIComponent(soql);
      const MAX_PAGES = 5; // Safety: limit pagination API calls for chat diagnostics
      let pages = 0;

      while (endpoint && pages < MAX_PAGES) {
        if (this.conversationManager?._turn !== activeTurn) throw new Error("Chat query cancelled");
        const response = await sfConn.rest(endpoint);
        records.push(...response.records);
        if (pages === 0) totalSize = response.totalSize || 0;
        endpoint = response.done ? null : response.nextRecordsUrl;
        pages++;
        // Safety: cap at 200 records for chat diagnostic queries
        if (records.length >= 200) break;
      }

      if (records.length === 0) {
        // SELECT COUNT() FROM ... returns the count in totalSize but with an
        // empty records array.  Create a synthetic row so the AI sees the value.
        if (/\bCOUNT\s*\(\s*\)/i.test(soql)) {
          return {
            success: true,
            rowCount: 1,
            columns: ["count"],
            _rows: [{count: totalSize}],
            aggregateValues: [{count: totalSize}]
          };
        }
        return {success: true, rowCount: 0, columns: [], _rows: []};
      }

      const flatRecords = records.map(r => flattenRecord(r));
      const colSet = new Set();
      for (const rec of flatRecords) {
        for (const key of Object.keys(rec)) colSet.add(key);
      }
      const columns = Array.from(colSet);
      const rows = flatRecords.map(rec => {
        const row = {};
        for (const col of columns) row[col] = rec[col] !== undefined ? rec[col] : null;
        return row;
      });

      const result = {success: true, rowCount: rows.length, columns, _rows: rows};
      // Detect aggregate queries (COUNT, SUM, etc.) and include values directly
      // in metadata so the AI can see results without needing row data consent.
      // Aggregate results don't contain PII — they're safe to auto-include.
      if (/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(soql) && rows.length <= 5) {
        result.aggregateValues = rows;
      }
      return result;
    } catch (e) {
      return {success: false, error: e.message || String(e)};
    }
  }

  /**
   * Ensure the dedicated chat SQLiteManager is initialized.
   * Uses a separate instance so chat diagnostic queries don't clobber the user's main results.
   */
  async _ensureChatSqlite() {
    if (this._chatSqliteReady) return;
    if (!this._chatSqliteManager) {
      this._chatSqliteManager = new SQLiteManager();
    }
    await this._chatSqliteManager.init();
    this._chatSqliteReady = true;
  }

  /**
   * Fetch records with a cap on total records and pagination pages.
   * Used by chat/AI queries to prevent runaway API usage.
   */
  async _fetchRecordsCapped(soql, maxRecords = 2000) {
    const activeTurn = this.conversationManager?._turn;
    const records = [];
    let endpoint = "/services/data/v" + apiVersion + (this.queryTooling ? "/tooling/query" : "/query") + "/?q=" + encodeURIComponent(soql);
    const MAX_PAGES = 10;
    let pages = 0;

    while (endpoint && pages < MAX_PAGES) {
      if (this.conversationManager?._turn !== activeTurn) throw new Error("Chat query cancelled");
      const response = await sfConn.rest(endpoint);
      records.push(...response.records);
      endpoint = response.done ? null : response.nextRecordsUrl;
      pages++;
      if (records.length >= maxRecords) break;
    }

    return records;
  }

  /**
   * Execute a full SQL-with-CTEs query for the chat/AI.
   * Uses a dedicated SQLite instance to avoid interfering with the user's main query.
   * Returns {success, rowCount, columns, _rows} or {success: false, error}.
   */
  async _executeQueryForChat(sql) {
    try {
      const parsed = parseQuery(sql);
      if (parsed.error) throw new Error(parsed.error);

      if (parsed.type === "soql") {
        return this._executeSoqlForChat(parsed.soql);
      }

      // SQL with CTEs — run through the full pipeline using the dedicated chat SQLite
      await this._ensureChatSqlite();
      await this._chatSqliteManager.reset();

      for (const cte of parsed.ctes) {
        if (!cte.soql) continue;
        const cacheKey = this._soqlCacheKey(cte.soql);
        const cached = this._soqlCache.get(cacheKey);

        if (cached) {
          await this._chatSqliteManager.createTableFromRecords(cte.name, cached.records);
        } else {
          // Cap at 2000 records per CTE for chat diagnostic queries to prevent runaway API usage
          const records = await this._fetchRecordsCapped(cte.soql, 2000);
          // Do NOT write to _soqlCache: chat fetches are capped and would silently
          // truncate data if the user later runs the same query in the main pipeline.
          await this._chatSqliteManager.createTableFromRecords(cte.name, records);
        }
      }

      const {columns, values} = await this._chatSqliteManager.executeQuery(parsed.finalQuery);
      const rows = values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
      });

      return {success: true, rowCount: values.length, columns, _rows: rows.slice(0, 100)};
    } catch (e) {
      return {success: false, error: e.message || String(e)};
    }
  }

  didUpdate(cb) {
    if (this.reactCallback) {
      this.reactCallback(cb);
    }
  }

  setResultsFilter(value) {
    this.resultsFilter = value;
    if (this.exportedData) {
      this.exportedData.updateVisibility(value);
      if (this.resultTableCallback) {
        this.resultTableCallback(this.exportedData);
      }
    }
    this.didUpdate();
  }

  /**
   * Initialize SQLite database
   */
  async initSQLite() {
    try {
      await this.sqliteManager.init();
      this.sqliteReady = true;
      this.didUpdate();
    } catch (err) {
      this.sqliteError = "Failed to initialize SQLite: " + err.message;
      console.error("SQLite init error:", err);
      this.didUpdate();
    }
  }

  /**
   * Fetch all records for a SOQL query (handles pagination)
   */
  async fetchAllRecords(soql, progressCallback) {
    const records = [];
    let endpoint = "/services/data/v" + apiVersion + (this.queryTooling ? "/tooling/query" : "/query") + "/?q=" + encodeURIComponent(soql);

    while (endpoint) {
      if (this.abortController?.signal.aborted) {
        throw new Error("Query cancelled");
      }

      const response = await sfConn.rest(endpoint);
      records.push(...response.records);

      if (progressCallback) {
        progressCallback(records.length, response.totalSize);
      }

      endpoint = response.done ? null : response.nextRecordsUrl;
    }

    return records;
  }

  /**
   * Execute the SQL query
   */
  async executeQuery(queryText) {
    this.isWorking = true;
    this.exportStatus = "Parsing query...";
    this.exportError = null;
    this.exportedData = null;
    this.progressTracker.reset();
    this.abortController = new AbortController();
    this.didUpdate();

    try {
      // Parse the query
      const parsed = parseQuery(queryText);

      if (parsed.error) {
        throw new Error(parsed.error);
      }

      if (parsed.type === "soql") {
        // Simple SOQL query - execute directly
        await this.executeSoqlQuery(parsed.soql);
      } else {
        // SQL with CTEs - need to extract data and run in SQLite
        await this.executeSqlWithCTEs(parsed.ctes, parsed.finalQuery);
      }

      // Add to history on success
      this.queryHistory.add({query: queryText, timestamp: Date.now()});

    } catch (err) {
      if (err.message !== "Query cancelled") {
        this.exportStatus = "Error";
        this.exportError = err.message;
        console.error("Query execution error:", err);
      }
    } finally {
      this.isWorking = false;
      this.abortController = null;
      this.didUpdate();
    }
  }

  /**
   * Execute a simple SOQL query
   */
  async executeSoqlQuery(soql) {
    const stepIndex = this.progressTracker.addStep("Executing SOQL query");
    this.progressTracker.updateStep(stepIndex, "in-progress");
    this.didUpdate();

    const records = await this.fetchAllRecords(soql, (current, total) => {
      this.exportStatus = `Fetching records... ${current}/${total}`;
      this.progressTracker.updateStep(stepIndex, "in-progress", `${current}/${total} records`);
      this.didUpdate();
    });

    this.progressTracker.updateStep(stepIndex, "completed", `${records.length} records`);

    // Create result table using the shared flattenRecord helper
    const resultTable = ResultTable();

    if (records.length > 0) {
      const flattenedRecords = records.map(r => flattenRecord(r));
      const columnSet = new Set();
      for (const rec of flattenedRecords) {
        for (const key of Object.keys(rec)) columnSet.add(key);
      }
      const columns = Array.from(columnSet);
      const values = flattenedRecords.map(rec => columns.map(col => rec[col] !== undefined ? rec[col] : null));
      resultTable.setFromSQLiteResults(columns, values);
    } else {
      resultTable.setFromSQLiteResults([], []);
    }

    this.exportedData = resultTable;
    this.exportStatus = `Completed: ${records.length} record${s(records.length)}`;

    if (this.resultTableCallback) {
      this.resultTableCallback(this.exportedData);
    }

    this.didUpdate();
  }

  /**
   * Build a cache key for a SOQL extraction.
   */
  _soqlCacheKey(soql) {
    return (this.queryTooling ? "tooling:" : "data:") + soql.trim();
  }

  /**
   * Clear the SOQL result cache so the next execution re-fetches everything.
   */
  clearSoqlCache() {
    this._soqlCache.clear();
    this.didUpdate();
  }

  /**
   * Execute SQL with CTEs (extract data, load into SQLite, run join)
   */
  async executeSqlWithCTEs(ctes, finalQuery) {
    // Ensure SQLite is ready
    if (!this.sqliteReady) {
      const initStep = this.progressTracker.addStep("Initializing SQLite");
      this.progressTracker.updateStep(initStep, "in-progress");
      this.didUpdate();

      await this.initSQLite();

      if (this.sqliteError) {
        throw new Error(this.sqliteError);
      }
      this.progressTracker.updateStep(initStep, "completed");
    }

    // Reset SQLite database (tables are recreated from cached or fresh data)
    await this.sqliteManager.reset();

    // Extract data for each CTE with SOQL
    for (const cte of ctes) {
      if (!cte.soql) continue;

      if (this.abortController?.signal.aborted) {
        throw new Error("Query cancelled");
      }

      const cacheKey = this._soqlCacheKey(cte.soql);
      const cached = this._soqlCache.get(cacheKey);

      if (cached) {
        // Use cached records – skip the Salesforce API call
        const stepIndex = this.progressTracker.addStep(`Extracting ${cte.name}`);
        this.progressTracker.updateStep(stepIndex, "in-progress", "loading from cache");
        this.exportStatus = `Loading ${cte.name} from cache...`;
        this.didUpdate();

        try {
          const {columns, rowCount} = await this.sqliteManager.createTableFromRecords(cte.name, cached.records);
          this.progressTracker.updateStep(stepIndex, "completed", `${rowCount} records, ${columns.length} columns (cached)`);
        } catch (err) {
          this.progressTracker.updateStep(stepIndex, "error", err.message);
          throw err;
        }
      } else {
        // Fetch from Salesforce
        const stepIndex = this.progressTracker.addStep(`Extracting ${cte.name}`);
        this.progressTracker.updateStep(stepIndex, "in-progress");
        this.exportStatus = `Extracting ${cte.name}...`;
        this.didUpdate();

        try {
          const records = await this.fetchAllRecords(cte.soql, (current, total) => {
            this.exportStatus = `Extracting ${cte.name}... ${current}/${total}`;
            this.progressTracker.updateStep(stepIndex, "in-progress", `${current}/${total} records`);
            this.didUpdate();
          });

          // Store in cache
          this._soqlCache.set(cacheKey, {records, soql: cte.soql, tooling: this.queryTooling, timestamp: Date.now()});

          // Load into SQLite
          const {columns, rowCount} = await this.sqliteManager.createTableFromRecords(cte.name, records);
          this.progressTracker.updateStep(stepIndex, "completed", `${rowCount} records, ${columns.length} columns`);

        } catch (err) {
          this.progressTracker.updateStep(stepIndex, "error", err.message);
          throw err;
        }
      }
    }

    // Execute final SQL query
    const finalStepIndex = this.progressTracker.addStep("Executing SQL join");
    this.progressTracker.updateStep(finalStepIndex, "in-progress");
    this.exportStatus = "Executing SQL join...";
    this.didUpdate();

    try {
      const {columns, values} = await this.sqliteManager.executeQuery(finalQuery);

      this.progressTracker.updateStep(finalStepIndex, "completed", `${values.length} rows`);

      // Create result table
      const resultTable = ResultTable();
      resultTable.setFromSQLiteResults(columns, values);

      this.exportedData = resultTable;
      this.exportStatus = `Completed: ${values.length} row${s(values.length)}`;

      if (this.resultTableCallback) {
        this.resultTableCallback(this.exportedData);
      }

    } catch (err) {
      this.progressTracker.updateStep(finalStepIndex, "error", err.message);
      throw new Error("SQL execution error: " + err.message);
    }

    this.didUpdate();
  }

  /**
   * Cancel the current query
   */
  cancelQuery() {
    if (this.abortController) {
      this.abortController.abort();
      this.isWorking = false;
      this.exportStatus = "Cancelled";
      this.didUpdate();
    }
  }
}

/**
 * Get CSV separator from settings
 */
function getSeparator() {
  const separator = localStorage.getItem("csvSeparator");
  if (separator === "tab") {
    return "\t";
  }
  return separator || ",";
}

let h = React.createElement;

/**
 * Progress Panel Component
 */
function ProgressPanel({steps}) {
  if (steps.length === 0) {
    return null;
  }

  return h("div", {className: "progress-panel"},
    steps.map((step, i) =>
      h("div", {key: i, className: `progress-item ${step.status}`},
        step.status === "pending" && h("span", {className: "progress-icon"}, "○"),
        step.status === "in-progress" && h("div", {className: "progress-spinner"}),
        step.status === "completed" && h("span", {className: "progress-check"}, "✓"),
        step.status === "error" && h("span", {className: "progress-x"}, "✗"),
        h("span", {}, step.name),
        step.details && h("span", {className: "progress-details"}, step.details)
      )
    )
  );
}

/**
 * Main App Component
 */
class App extends React.Component {
  constructor(props) {
    super(props);
    this.onExecute = this.onExecute.bind(this);
    this.onCancel = this.onCancel.bind(this);
    this.onClearCache = this.onClearCache.bind(this);
    this.onToggleHelp = this.onToggleHelp.bind(this);
    this.onToggleTooling = this.onToggleTooling.bind(this);
    this.onInsertQueryFromChat = this.onInsertQueryFromChat.bind(this);
    this.onCopyAsExcel = this.onCopyAsExcel.bind(this);
    this.onCopyAsCsv = this.onCopyAsCsv.bind(this);
    this.onCopyAsJson = this.onCopyAsJson.bind(this);
    this.onDownloadAsCsv = this.onDownloadAsCsv.bind(this);
    this.onResultsFilterInput = this.onResultsFilterInput.bind(this);
    this.onSelectHistoryEntry = this.onSelectHistoryEntry.bind(this);
    this.onClearHistory = this.onClearHistory.bind(this);
    this._onDrawerResizeStart = this._onDrawerResizeStart.bind(this);

    this.state = {
      showHelp: false,
      drawerWidth: 380
    };
  }

  // --- Drawer resize via drag handle ---
  _onDrawerResizeStart(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = this.state.drawerWidth;

    const onMouseMove = (ev) => {
      // Dragging left increases width, dragging right decreases it
      const delta = startX - ev.clientX;
      const newWidth = Math.max(260, Math.min(startWidth + delta, window.innerWidth * 0.6));
      this.setState({drawerWidth: newWidth});
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  componentDidMount() {
    let {model} = this.props;

    // Initialize SQLite in background
    model.initSQLite();

    // Eagerly initialise conversation manager so the chat drawer is ready
    if (isGeminiEnabled()) {
      model.ensureConversationManager();
    }

    // Set up scroll table if available
    this.initScrollTableIfNeeded();

    // Recalculate on window resize
    addEventListener("resize", () => {
      model.winInnerHeight = innerHeight;
      model.didUpdate();
    });
  }

  componentDidUpdate() {
    // Set up scroll table when it becomes available (after SQLite loads)
    this.initScrollTableIfNeeded();
    // Notify scroll table of viewport changes so it can render visible rows
    if (this.scrollTable) {
      this.scrollTable.viewportChange();
    }
  }

  initScrollTableIfNeeded() {
    let {model} = this.props;
    if (this.refs.scroller && !this.scrollTable) {
      this.scrollTable = initScrollTable(this.refs.scroller);
      model.resultTableCallback = this.scrollTable.dataChange;
    }
  }

  onExecute() {
    let {model} = this.props;
    const query = this.refs.query.value;
    model.executeQuery(query);
  }

  onCancel() {
    let {model} = this.props;
    model.cancelQuery();
  }

  onClearCache() {
    let {model} = this.props;
    model.clearSoqlCache();
  }

  onToggleHelp() {
    this.setState({showHelp: !this.state.showHelp});
  }

  onToggleTooling(e) {
    let {model} = this.props;
    model.queryTooling = e.target.checked;
    if (model.conversationManager) {
      model.conversationManager.useToolingApi = e.target.checked;
    }
    model.didUpdate();
  }

  onInsertQueryFromChat(queryText) {
    const q = String(queryText || "").trim();
    if (!q) return;
    if (this.refs.query) {
      this.refs.query.value = q;
    }
    let {model} = this.props;
    model.didUpdate();
  }

  onCopyAsExcel() {
    let {model} = this.props;
    if (model.exportedData) {
      copyToClipboard(model.exportedData.csvSerialize("\t"));
    }
  }

  onCopyAsCsv() {
    let {model} = this.props;
    if (model.exportedData) {
      copyToClipboard(model.exportedData.csvSerialize(getSeparator()));
    }
  }

  onCopyAsJson() {
    let {model} = this.props;
    if (model.exportedData) {
      copyToClipboard(JSON.stringify(model.exportedData.records, null, 2));
    }
  }

  onDownloadAsCsv() {
    let {model} = this.props;
    if (model.exportedData) {
      downloadCsvFile(model.exportedData.csvSerialize(getSeparator()), "sql-query-results.csv");
    }
  }

  onResultsFilterInput(e) {
    let {model} = this.props;
    model.setResultsFilter(e.target.value);
  }

  onSelectHistoryEntry(e) {
    let {model} = this.props;
    const index = e.target.value;
    if (index !== "" && model.queryHistory.list[index]) {
      this.refs.query.value = model.queryHistory.list[index].query;
    }
    e.target.value = "";
    model.didUpdate();
  }

  onClearHistory() {
    let {model} = this.props;
    model.queryHistory.clear();
    model.didUpdate();
  }

  canExecute() {
    let {model} = this.props;
    return model.sqliteReady && !model.isWorking && this.refs.query?.value?.trim();
  }

  canCopy() {
    let {model} = this.props;
    return model.exportedData && model.exportedData.table.length > 1;
  }

  render() {
    let {model} = this.props;

    return h("div", {},
      h(PageHeader, {
        pageTitle: "SQL Query",
        orgName: model.orgName,
        sfLink: model.sfLink,
        sfHost: model.sfHost,
        spinnerCount: model.spinnerCount,
        userInitials: model.userInfoModel.userInitials,
        userFullName: model.userInfoModel.userFullName,
        userName: model.userInfoModel.userName
      }),

      h("div", {className: "slds-m-top_xx-large sfir-page-container sql-page-layout"},

        // Main content column
        h("div", {className: "sql-main-content"},

          // SQLite loading indicator
          !model.sqliteReady && !model.sqliteError && h("div", {className: "sqlite-loading"},
            h("div", {className: "sqlite-loading-spinner"}),
            h("span", {}, "Loading SQL engine...")
          ),

          // SQLite error
          model.sqliteError && h("div", {className: "slds-notify slds-notify_alert slds-theme_error slds-m-around_medium"},
            model.sqliteError
          ),

          // Query area - wrapped in slds-card like data-export
          model.sqliteReady && h("div", {className: "slds-card slds-m-around_medium"},
            h("div", {className: "slds-card__body slds-card__body_inner"},
              h("div", {className: "query-controls"},
                h("h3", {className: "slds-text-heading_small slds-m-bottom_xx-small slds-m-left_xxx-small"}, "SQL Query"),
                h("div", {className: "query-history-controls"},
                  h("label", {className: "slds-m-right_medium"},
                    h("input", {
                      type: "checkbox",
                      checked: model.queryTooling,
                      onChange: this.onToggleTooling
                    }),
                    " Use Tooling API"
                  ),
                  h("div", {className: "slds-button-group"},
                    h("select", {
                      onChange: this.onSelectHistoryEntry,
                      title: "Query history",
                      defaultValue: "",
                      className: "query-history"
                    },
                      h("option", {value: "", disabled: true}, "History..."),
                      model.queryHistory.list.map((entry, i) =>
                        h("option", {key: i, value: i},
                          entry.query.substring(0, 100).replace(/\s+/g, " ") + (entry.query.length > 100 ? "..." : "")
                        )
                      )
                    ),
                    h("button", {
                      className: "slds-button slds-button_neutral",
                      onClick: this.onClearHistory,
                      title: "Clear history",
                      disabled: model.queryHistory.list.length === 0
                    }, "Clear")
                  )
                )
              ),
              h("textarea", {
                id: "query",
                ref: "query",
                style: {maxHeight: (model.winInnerHeight ? model.winInnerHeight - 200 : 400) + "px"},
                defaultValue: model.initialQuery,
                placeholder: "Enter SQL query with CTEs...",
                spellCheck: false
              }),
              h("div", {className: "autocomplete-box"},
                h("div", {className: "autocomplete-header"},
                  h("span", {className: "slds-m-left_xx-small"}),
                  h("ul", {className: "slds-button-group-row flex-right"},
                    h("li", {className: "slds-button-group-item"},
                      h("button", {
                        disabled: !this.canExecute(),
                        onClick: this.onExecute,
                        title: "Execute query",
                        className: "slds-button slds-button_brand"
                      }, "Execute")
                    ),
                    h("li", {className: "slds-button-group-item"},
                      h("button", {
                        className: "slds-button slds-button_destructive",
                        onClick: this.onCancel,
                        disabled: !model.isWorking
                      }, "Cancel")
                    ),
                    model._soqlCache.size > 0 && h("li", {className: "slds-button-group-item"},
                      h("button", {
                        className: "slds-button slds-button_neutral",
                        onClick: this.onClearCache,
                        disabled: model.isWorking,
                        title: "Clear cached SOQL results so the next execution re-fetches all data from Salesforce"
                      }, "Clear cache (" + model._soqlCache.size + ")")
                    ),
                    h("li", {className: "slds-button-group-item"},
                      h("div", {className: "slds-dropdown-trigger"},
                        h("button", {
                          className: "slds-button slds-button_icon slds-button_icon-more toggle " + (this.state.showHelp ? "contract" : "expand"),
                          onClick: this.onToggleHelp,
                          title: this.state.showHelp ? "Hide help" : "Show help"
                        },
                          h("div", {className: "button-icon"}),
                          h("div", {className: "button-toggle-icon"})
                        )
                      )
                    )
                  )
                )
              ),

              // Help text
              !this.state.showHelp ? null : h("div", {className: "slds-box slds-theme_info slds-m-top_medium"},
                h("h3", {className: "slds-text-heading_small slds-m-bottom_small"}, "SQL Query with SOQL Data Extraction"),
                h("p", {className: "slds-m-bottom_x-small"}, "Write SQLite queries with CTEs (Common Table Expressions) that automatically extract data from Salesforce."),
                h("p", {className: "slds-m-bottom_x-small"}, "Each CTE should include a ", h("code", {}, "/* SOQL: ... */"), " comment specifying the SOQL query to extract data."),
                h("p", {className: "slds-m-bottom_x-small"}, "Example:"),
                h("pre", {},
`WITH accounts AS (
  /* SOQL: SELECT Id, Name, Industry FROM Account WHERE Industry != null */
  SELECT * FROM accounts
),
contacts AS (
  /* SOQL: SELECT Id, FirstName, LastName, AccountId FROM Contact */
  SELECT * FROM contacts
)
SELECT a.Name, a.Industry, c.FirstName, c.LastName
FROM accounts a
JOIN contacts c ON a.Id = c.AccountId
WHERE a.Industry = 'Technology'`
                ),
                h("p", {className: "slds-m-bottom_x-small slds-m-top_small"}, h("strong", {}, "How it works:")),
                h("ol", {},
                  h("li", {}, "CTEs with SOQL comments are parsed and SOQL queries are extracted"),
                  h("li", {}, "Each SOQL query is executed against Salesforce (with pagination)"),
                  h("li", {}, "Results are loaded into an in-browser SQL database"),
                  h("li", {}, "The final SQL query (SELECT/JOIN) is executed locally"),
                  h("li", {}, "Results are displayed in the table below")
                ),
                h("p", {className: "slds-m-bottom_x-small"}, "You can also run simple SOQL queries directly (without CTEs).")
              ),

              // Progress panel
              h(ProgressPanel, {steps: model.progressTracker.getSteps()})
            )
          ),

          // Results area
          h("div", {
            className: "slds-card slds-m-horizontal_medium slds-m-bottom_medium",
            id: "result-area",
            style: {flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column"}
          },
            h("div", {className: "slds-card__body slds-card__body_inner", style: {flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column"}},
              h("div", {className: "result-bar"},
                h("h3", {className: "slds-text-heading_small"}, "Results"),
                h("div", {className: "slds-button-group slds-m-left_small"},
                  h("button", {
                    className: "slds-button slds-button_neutral",
                    disabled: !this.canCopy(),
                    onClick: this.onCopyAsExcel,
                    title: "Copy results to clipboard for pasting into Excel"
                  }, "Copy (Excel)"),
                  h("button", {
                    className: "slds-button slds-button_neutral",
                    disabled: !this.canCopy(),
                    onClick: this.onCopyAsCsv,
                    title: "Copy results as CSV"
                  }, "Copy (CSV)"),
                  h("button", {
                    className: "slds-button slds-button_neutral",
                    disabled: !this.canCopy(),
                    onClick: this.onCopyAsJson,
                    title: "Copy results as JSON"
                  }, "Copy (JSON)"),
                  h("button", {
                    className: "slds-button slds-button_neutral",
                    disabled: !this.canCopy(),
                    onClick: this.onDownloadAsCsv,
                    title: "Download as CSV file"
                  },
                    h("svg", {className: "slds-button__icon"},
                      h("use", {xlinkHref: "symbols.svg#download"})
                    )
                  )
                ),
                model.exportedData && model.exportedData.table.length > 1 && h("div", {className: "slds-form-element slds-m-left_small"},
                  h("input", {
                    type: "search",
                    className: "slds-input slds-button slds-m-around_none",
                    placeholder: "Filter results...",
                    value: model.resultsFilter,
                    onInput: this.onResultsFilterInput
                  })
                ),
                h("span", {className: "result-status flex-right"},
                  h("span", {className: `slds-badge slds-theme_${model.exportError ? "error" : "success"}`}, model.exportStatus)
                )
              ),
              h("textarea", {
                className: "slds-box slds-theme_error",
                readOnly: true,
                value: nullToEmptyString(model.exportError),
                hidden: model.exportError == null,
                style: {flex: "1 1 0", minHeight: 0, resize: "none"}
              }),
              model.exportError && isGeminiEnabled() && h("div", {className: "slds-m-top_x-small slds-text-align_right"},
                h("button", {
                  className: "slds-button slds-button_brand",
                  title: "Send error to AI chat for debugging",
                  onClick: () => {
                    model.ensureConversationManager();
                    const cm = model.conversationManager;
                    if (!cm || cm.isProcessing) return;
                    // Avoid flooding: skip if the last user message already has the same error
                    const lastUserMsg = [...cm.messages].reverse().find(m => m.role === "user");
                    if (lastUserMsg?.text === "Fix this error" && lastUserMsg?.context?.error === model.exportError) return;
                    const ctx = {};
                    const q = this.refs.query?.value || model.initialQuery || "";
                    if (q) ctx.query = q;
                    if (model.exportError) ctx.error = model.exportError;
                    cm.sendMessage("Fix this error", Object.keys(ctx).length > 0 ? ctx : null);
                  }
                }, "Fix with AI")
              ),
              h("div", {
                ref: "scroller",
                hidden: model.exportError != null,
                style: {flex: "1 1 0", minHeight: 0, maxHeight: "100%", overflowY: "auto"}
              })
            )
          )
        ), // Close sql-main-content

        // Chat drawer (always visible when Gemini is enabled)
        isGeminiEnabled() && h("div", {
          className: "sql-chat-drawer",
          style: {flexBasis: this.state.drawerWidth + "px", maxWidth: this.state.drawerWidth + "px"}
        },
          h("div", {className: "chat-drawer-resize-handle", onMouseDown: this._onDrawerResizeStart}),
          h(ChatPanel, {
            conversationManager: model.conversationManager,
            getCurrentQuery: () => this.refs.query?.value || model.initialQuery || "",
            currentError: model.exportError || "",
            exportedData: model.exportedData,
            onInsertQuery: this.onInsertQueryFromChat
          })
        )
      ) // Close sfir-page-container
    );
  }
}

// Initialize the app
function init() {
  let args = new URLSearchParams(location.search);
  let sfHost = args.get("host");

  console.log("SQL Query init - URL:", location.href);
  console.log("SQL Query init - sfHost:", sfHost);

  // Validate host parameter
  if (!sfHost) {
    document.getElementById("root").innerHTML = `
      <div style="padding: 20px; font-family: sans-serif;">
        <h2 style="color: #c23934;">Error: Missing host parameter</h2>
        <p>This page must be opened from the Salesforce Inspector extension popup.</p>
        <p>Please navigate to a Salesforce page and click the extension icon, then select "SQL Query (Join)".</p>
      </div>
    `;
    return;
  }

  sfConn.getSession(sfHost).then(() => {
    let model = new Model({sfHost, args});

    model.reactCallback = (cb) => {
      ReactDOM.render(h(App, {model}), document.getElementById("root"), cb);
    };
    model.reactCallback();

    // Initialize button listeners
    if (typeof initButton === "function") {
      initButton();
    }
  }).catch(err => {
    console.error("Session error:", err);
    document.getElementById("root").textContent = "Error: Unable to connect to Salesforce. " + err.message;
  });
}

init();
