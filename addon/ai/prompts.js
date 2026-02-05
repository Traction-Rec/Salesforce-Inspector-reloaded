export const QueryKind = {
  soql: "soql",
  sqlCte: "sqlCte"
};

function compactSchema(schemaText) {
  const t = String(schemaText || "").trim();
  return t ? t : "Schema unavailable.";
}

export function buildSystemInstruction(kind) {
  if (kind === QueryKind.sqlCte) {
    return [
      "You are an expert Salesforce + SQLite query builder.",
      "The user is using a tool that executes Salesforce SOQL queries, loads them into a local SQLite database, then runs a final SQL join.",
      "",
      "You MUST output ONLY the query text. No explanations. No markdown.",
      "",
      "For SQL-with-CTEs output:",
      "- The query MUST start with WITH.",
      "- Each extraction source MUST be a CTE in the form: CteName AS ( ... )",
      "- Inside each CTE body, include a magic comment: /* SOQL: <SOQL query> */",
      "- CteName must match /\\w+/. Use short, readable names (accounts, contacts, etc.).",
      "- The rest of the CTE body can be a placeholder valid SQL statement (it is ignored by the tool), e.g. SELECT 1 AS _",
      "- After the CTEs, include a final SELECT statement that joins the CTE tables by name.",
      "",
      "Cost control (CRITICAL): each SOQL extraction must be as narrow as possible.",
      "- Select ONLY the fields required for the final SQL output, joins, filters, and ordering. Do NOT use SELECT *.",
      "- Avoid full-table dumps. Always add a selective WHERE clause unless the user explicitly requests a full export.",
      "- Include a LIMIT (default to LIMIT 200) unless the user explicitly requests otherwise.",
      "- Prefer filtering by selective fields (Id, CreatedDate, LastModifiedDate, RecordTypeId, IsDeleted, etc.) when possible.",
      "- If you need to match a subset (e.g. Name LIKE '%rec%'), still include an additional bounding filter (date range, status) when possible."
    ].join("\n");
  }

  // Default to SOQL
  return [
    "You are an expert Salesforce SOQL query builder.",
    "You MUST output ONLY the SOQL query text. No explanations. No markdown.",
    "The query must be valid SOQL and start with SELECT.",
    "",
    "Cost control (CRITICAL): keep the query narrow and selective.",
    "- Select ONLY the fields needed for the user's request. Avoid pulling lots of columns.",
    "- Avoid full-table dumps. Add a selective WHERE clause unless the user explicitly requests otherwise.",
    "- Include a LIMIT (default to LIMIT 200) unless the user explicitly requests otherwise."
  ].join("\n");
}

export function buildGenerationPrompt({kind, userRequest, schemaText}) {
  const schema = compactSchema(schemaText);
  const request = String(userRequest || "").trim();
  return [
    "## Task",
    kind === QueryKind.sqlCte
      ? "Generate a SQL query with CTEs that extract Salesforce data via SOQL magic comments."
      : "Generate a Salesforce SOQL query.",
    "",
    "## Schema",
    schema,
    "",
    "## User request",
    request || "(no request provided)"
  ].join("\n");
}

export function buildFixPrompt({kind, userInstruction, query, error, schemaText}) {
  const schema = compactSchema(schemaText);
  const instruction = String(userInstruction || "").trim();
  const q = String(query || "").trim();
  const e = String(error || "").trim();
  return [
    "## Task",
    "Fix the query. Return ONLY the corrected query text (no explanations, no markdown).",
    "",
    kind === QueryKind.sqlCte
      ? "Remember: CTE format must include /* SOQL: ... */ comments inside each CTE and start with WITH. Keep each SOQL extraction narrow (minimal fields, selective WHERE, default LIMIT 200)."
      : "Remember: the query must be valid SOQL and start with SELECT. Keep it narrow (minimal fields, selective WHERE, default LIMIT 200).",
    "",
    "## Schema",
    schema,
    "",
    "## Current query",
    q || "(empty)",
    "",
    "## Error",
    e || "(no error)",
    "",
    "## Additional instructions",
    instruction || "(none)"
  ].join("\n");
}

