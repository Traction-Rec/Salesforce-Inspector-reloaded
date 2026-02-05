import {sfConn, apiVersion} from "../inspector.js";
import {extractObjectName} from "../lib/sql-parser.js";

function uniq(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

export function extractSObjectNamesFromSoql(soql) {
  const name = extractObjectName(String(soql || ""));
  return name ? [name] : [];
}

async function fetchSObjectDescribe({sobjectName, useToolingApi}) {
  const prefix = useToolingApi ? "tooling/" : "";
  const endpoint = `/services/data/v${apiVersion}/${prefix}sobjects/${encodeURIComponent(sobjectName)}/describe`;
  return await sfConn.rest(endpoint);
}

function serializeSObjectDescribe(sobjectName, describe, {maxFields = 60} = {}) {
  const fields = Array.isArray(describe?.fields) ? describe.fields : [];
  const truncated = fields.length > maxFields;
  const subset = truncated ? fields.slice(0, maxFields) : fields;

  const fieldLines = subset.map(f => {
    const parts = [f.name];
    if (f.type) parts.push(`type=${f.type}`);
    if (typeof f.length === "number") parts.push(`len=${f.length}`);
    if (typeof f.precision === "number") parts.push(`precision=${f.precision}`);
    if (typeof f.scale === "number") parts.push(`scale=${f.scale}`);
    if (Array.isArray(f.referenceTo) && f.referenceTo.length) parts.push(`ref=${f.referenceTo.join("|")}`);
    return `- ${parts.join(" ")}`;
  });

  return [
    `SObject ${sobjectName}:`,
    ...fieldLines,
    truncated ? `- ... (${fields.length - maxFields} more fields truncated)` : ""
  ].filter(Boolean).join("\n");
}

async function describeSafe({sobjectName, useToolingApi, maxFields}) {
  try {
    const describe = await fetchSObjectDescribe({sobjectName, useToolingApi});
    return serializeSObjectDescribe(sobjectName, describe, {maxFields});
  } catch (e) {
    // Gracefully degrade so a single bad object doesn't block the whole prompt
    return `SObject ${sobjectName}: (describe failed – ${e.message || e})`;
  }
}

export async function collectSoqlSchemaText({
  soql,
  useToolingApi = false,
  maxObjects = 4,
  maxFieldsPerObject = 60
}) {
  const sobjects = extractSObjectNamesFromSoql(soql).slice(0, maxObjects);
  if (sobjects.length === 0) {
    return "Could not determine SObject from SOQL (no FROM clause detected).";
  }

  const blocks = await Promise.all(
    sobjects.map(sobjectName => describeSafe({sobjectName, useToolingApi, maxFields: maxFieldsPerObject}))
  );

  return blocks.join("\n\n");
}

export async function collectMultiSoqlSchemaText({
  soqlList,
  useToolingApi = false,
  maxObjects = 6,
  maxFieldsPerObject = 60
}) {
  const names = uniq((soqlList || []).flatMap(extractSObjectNamesFromSoql)).slice(0, maxObjects);
  if (names.length === 0) {
    return "Could not determine SObjects from SOQL.";
  }

  const blocks = await Promise.all(
    names.map(sobjectName => describeSafe({sobjectName, useToolingApi, maxFields: maxFieldsPerObject}))
  );

  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// SObject discovery + fuzzy suggestion from natural-language prompts
// ---------------------------------------------------------------------------

let _sobjectListCache = null;

/**
 * Fetch queryable SObject names (cached per tooling-api flag).
 */
export async function fetchSObjectNames({useToolingApi = false} = {}) {
  if (_sobjectListCache && _sobjectListCache.useToolingApi === useToolingApi) {
    return _sobjectListCache.list;
  }
  const prefix = useToolingApi ? "tooling/" : "";
  const endpoint = `/services/data/v${apiVersion}/${prefix}sobjects/`;
  const result = await sfConn.rest(endpoint);
  const list = (result.sobjects || [])
    .filter(obj => obj.queryable !== false)
    .map(obj => ({name: obj.name, label: obj.label || obj.name}));
  _sobjectListCache = {useToolingApi, list};
  return list;
}

function splitCamelCase(str) {
  return str
    .replace(/__c$/i, "")
    .replace(/__/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 2);
}

function depluralize(word) {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

/* eslint-disable */
const STOP_WORDS = new Set([
  "the","a","an","and","or","for","of","in","on","at","to","from","with","by",
  "is","are","was","were","be","been","being","have","has","had","do","does",
  "did","will","would","could","should","may","might","can","shall","not","no",
  "all","each","every","any","some","where","when","how","what","which","who",
  "whom","that","this","these","those","it","its","my","your","our","their",
  "his","her","me","him","them","us","we","you","they","i","am",
  "like","contains","containing","include","includes","including",
  "select","get","find","show","list","give","fetch","query","search",
  "null","empty","blank","limit","offset","order","group","count",
  "name","id","type","value","field","fields","record","records",
  "number","date","text","string","true","false"
]);
/* eslint-enable */

/**
 * Fuzzy-match a natural-language prompt against a list of SObject names.
 * Returns up to `maxResults` suggestions sorted by relevance.
 */
export function suggestSObjectsFromPrompt(promptText, sobjectList, maxResults = 15) {
  const tokens = String(promptText || "").toLowerCase()
    .split(/[^a-zA-Z0-9_]+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
  if (tokens.length === 0) return [];

  const normalizedTokens = tokens.map(depluralize);
  const allTokens = [...new Set([...tokens, ...normalizedTokens])];

  const scored = [];
  for (const obj of sobjectList) {
    // Avoid auto-suggesting Share/History objects; they are expensive/noisy and rarely intended.
    // Users can still manually select them from the full list if needed.
    const objNameLower = String(obj.name || "").toLowerCase();
    if (objNameLower.endsWith("__share") || objNameLower.endsWith("__history")) {
      continue;
    }

    const nameLower = obj.name.toLowerCase();
    const nameClean = nameLower.replace(/__c$/, "");
    const labelLower = (obj.label || "").toLowerCase();
    const nameParts = splitCamelCase(obj.name);
    const labelParts = labelLower.split(/[^a-z0-9]+/).filter(w => w.length >= 2);

    let score = 0;
    for (const token of allTokens) {
      if (nameClean === token || nameLower === token) score += 20;
      else if (labelLower === token) score += 15;
      else if (nameParts.some(p => p === token)) score += 10;
      else if (labelParts.some(p => p === token)) score += 8;
      else if (nameClean.includes(token) && token.length >= 3) score += 5;
      else if (labelLower.includes(token) && token.length >= 3) score += 3;
    }
    if (score > 0) {
      scored.push({name: obj.name, label: obj.label, score});
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}

/**
 * Fetch and serialize schema for an explicit list of SObject names.
 */
export async function collectSchemaForObjects({
  objectNames,
  useToolingApi = false,
  maxFieldsPerObject = Infinity
}) {
  if (!objectNames || objectNames.length === 0) return "";
  const blocks = await Promise.all(
    objectNames.map(sobjectName => describeSafe({sobjectName, useToolingApi, maxFields: maxFieldsPerObject}))
  );
  return blocks.join("\n\n");
}

