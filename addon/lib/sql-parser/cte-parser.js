// CTE (Common Table Expression) parser
//
// This module handles parsing of SQL CTEs (WITH clauses) that contain
// SOQL extraction directives in magic comments.

import {
  stripLeadingComments,
  ParserContext,
  handleStringLiteral,
  skipBlockComment,
  skipLineComment,
  handleParentheses
} from './tokenizer.js';

/**
 * Extracts CTE definitions from a SQL query with SOQL magic comments.
 * 
 * @param {string} sqlQuery - The full SQL query with CTEs
 * @returns {Array<{name: string, soql: string, sqlBody: string}>} Array of CTE definitions
 */
export function extractCTEs(sqlQuery) {
  const ctes = [];
  
  // Normalize line endings
  const normalizedQuery = sqlQuery.replace(/\r\n/g, '\n');
  
  // Strip leading comments before checking for WITH keyword
  const strippedQuery = stripLeadingComments(normalizedQuery);
  
  // Check if query starts with WITH (case insensitive)
  const withMatch = strippedQuery.match(/^\s*WITH\s+/i);
  if (!withMatch) {
    return ctes;
  }
  
  // Find where the CTEs end and the main query begins
  const queryWithoutWith = strippedQuery.substring(withMatch[0].length);
  
  // Split CTEs - this is tricky because CTEs are comma-separated but
  // may contain commas inside parentheses
  const cteDefinitions = splitCTEs(queryWithoutWith);
  
  for (const cteDef of cteDefinitions) {
    const parsed = parseSingleCTE(cteDef);
    if (parsed) {
      ctes.push(parsed);
    }
  }
  
  return ctes;
}

/**
 * Splits the CTE section into individual CTE definitions.
 * Handles nested parentheses correctly.
 * 
 * @param {string} cteSection - The query after "WITH " keyword
 * @returns {Array<string>} Array of individual CTE definition strings
 */
function splitCTEs(cteSection) {
  const ctes = [];
  let current = '';
  const ctx = new ParserContext(cteSection);
  
  while (!ctx.isAtEnd()) {
    // Handle string literals (advances internally)
    const strStart = ctx.index;
    if (handleStringLiteral(ctx)) {
      current += ctx.input.substring(strStart, ctx.index);
      continue;
    }
    
    // Skip comments but keep them in output
    if (ctx.currentChar === '/' && ctx.nextChar === '*') {
      const commentStart = ctx.index;
      skipBlockComment(ctx);
      current += ctx.input.substring(commentStart, ctx.index);
      continue;
    }
    
    if (ctx.currentChar === '-' && ctx.nextChar === '-') {
      const commentStart = ctx.index;
      skipLineComment(ctx);
      current += ctx.input.substring(commentStart, ctx.index);
      continue;
    }
    
    // Track parentheses depth (does not advance)
    if (handleParentheses(ctx)) {
      current += ctx.currentChar;
      
      // If we're back to depth 0, check if this is the end of a CTE
      if (ctx.depth === 0 && ctx.currentChar === ')') {
        // Look ahead for comma or SELECT/main query
        const remaining = ctx.input.substring(ctx.index + 1).trim();
        
        if (remaining.startsWith(',')) {
          // Another CTE follows
          ctes.push(current.trim());
          current = '';
          // Skip past the comma (land on first char after it)
          ctx.index = ctx.input.indexOf(',', ctx.index) + 1;
          continue;
        } else if (isMainQueryStart(remaining)) {
          // Main query follows - we're done with CTEs
          ctes.push(current.trim());
          return ctes;
        }
      }
      ctx.advance();
      continue;
    }
    
    current += ctx.currentChar;
    ctx.advance();
  }
  
  // Handle any remaining content
  if (current.trim()) {
    ctes.push(current.trim());
  }
  
  return ctes;
}

/**
 * Checks if the remaining text starts a main SQL query
 * 
 * @param {string} text - Text to check
 * @returns {boolean} True if text starts with SELECT, INSERT, UPDATE, or DELETE
 */
function isMainQueryStart(text) {
  return /^SELECT\s/i.test(text) || 
         /^INSERT\s/i.test(text) || 
         /^UPDATE\s/i.test(text) || 
         /^DELETE\s/i.test(text);
}

/**
 * Parses a single CTE definition and extracts the SOQL comment if present.
 * 
 * @param {string} cteDef - A single CTE definition string
 * @returns {{name: string, soql: string, sqlBody: string}|null} Parsed CTE or null if invalid
 */
function parseSingleCTE(cteDef) {
  // Match: cteName AS (body)
  const match = cteDef.match(/^(\w+)\s+AS\s*\(([\s\S]*)\)\s*$/i);
  if (!match) {
    return null;
  }
  
  const name = match[1];
  const body = match[2];
  
  // Extract SOQL from magic comment: /* SOQL: ... */
  const soqlMatch = body.match(/\/\*\s*SOQL:\s*([\s\S]*?)\s*\*\//i);
  const soql = soqlMatch ? soqlMatch[1].trim() : null;
  
  // Get the SQL body (everything after the SOQL comment, or the whole body if no comment)
  let sqlBody = body;
  if (soqlMatch) {
    // Remove the SOQL comment from the body
    sqlBody = body.replace(soqlMatch[0], '').trim();
  }
  
  return {
    name,
    soql,
    sqlBody
  };
}

/**
 * Extracts the final SELECT query (after all CTEs).
 * 
 * @param {string} sqlQuery - The full SQL query with CTEs
 * @returns {string} The final query without CTE definitions
 */
export function getFinalQuery(sqlQuery) {
  // Normalize line endings
  const normalizedQuery = sqlQuery.replace(/\r\n/g, '\n');
  
  // Strip leading comments before checking for WITH keyword
  const strippedQuery = stripLeadingComments(normalizedQuery);
  
  // Check if query starts with WITH
  const withMatch = strippedQuery.match(/^\s*WITH\s+/i);
  if (!withMatch) {
    // No CTEs, return the whole query
    return strippedQuery.trim();
  }
  
  // Find the main query by tracking parentheses after WITH
  const queryWithoutWith = strippedQuery.substring(withMatch[0].length);
  const ctx = new ParserContext(queryWithoutWith);
  
  while (!ctx.isAtEnd()) {
    // Handle string literals (advances internally)
    if (handleStringLiteral(ctx)) {
      continue;
    }
    
    // Skip comments
    if (skipBlockComment(ctx) || skipLineComment(ctx)) {
      continue;
    }
    
    // Track parentheses depth (does not advance)
    if (handleParentheses(ctx)) {
      if (ctx.depth === 0 && ctx.currentChar === ')') {
        // Look ahead for the main query
        const remaining = ctx.input.substring(ctx.index + 1).trim();
        
        if (remaining.startsWith(',')) {
          // Another CTE follows – skip past the comma
          ctx.index = ctx.input.indexOf(',', ctx.index) + 1;
          continue;
        } else if (isMainQueryStart(remaining)) {
          // Found the main query
          return remaining;
        }
      }
      ctx.advance();
      continue;
    }
    
    ctx.advance();
  }
  
  // Fallback: return remaining query
  return queryWithoutWith.trim();
}

/**
 * Reconstructs a full SQL query with CTEs from the extracted parts.
 * This is useful for executing in SQLite after loading data.
 * 
 * @param {Array<{name: string, sqlBody: string}>} ctes - Array of CTE definitions
 * @param {string} finalQuery - The main query
 * @returns {string} Complete SQL query
 */
export function reconstructQuery(ctes, finalQuery) {
  if (ctes.length === 0) {
    return finalQuery;
  }
  
  const cteStrings = ctes.map(cte => `${cte.name} AS (${cte.sqlBody})`);
  return `WITH ${cteStrings.join(',\n     ')}\n${finalQuery}`;
}
