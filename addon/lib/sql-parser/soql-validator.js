// SOQL validation utilities
//
// This module provides validation functions for SOQL queries extracted
// from SQL CTE magic comments.

/**
 * Validates a SOQL query for basic syntax.
 * 
 * @param {string} soql - The SOQL query to validate
 * @returns {{valid: boolean, error: string|null}} Validation result
 */
export function validateSOQL(soql) {
  if (!soql || typeof soql !== 'string') {
    return { valid: false, error: 'SOQL query is empty or not a string' };
  }
  
  const trimmed = soql.trim();
  
  // Must start with SELECT
  if (!/^SELECT\s/i.test(trimmed)) {
    return { valid: false, error: 'SOQL query must start with SELECT' };
  }
  
  // Must contain FROM
  if (!/\sFROM\s/i.test(trimmed)) {
    return { valid: false, error: 'SOQL query must contain FROM clause' };
  }
  
  // Check for balanced parentheses
  let depth = 0;
  for (const char of trimmed) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0) {
      return { valid: false, error: 'Unbalanced parentheses in SOQL query' };
    }
  }
  if (depth !== 0) {
    return { valid: false, error: 'Unbalanced parentheses in SOQL query' };
  }
  
  return { valid: true, error: null };
}

/**
 * Extracts the object name from a SOQL query.
 * 
 * @param {string} soql - The SOQL query
 * @returns {string|null} The Salesforce object name
 */
export function extractObjectName(soql) {
  // Match: FROM ObjectName or FROM ObjectName WHERE/ORDER/GROUP/LIMIT
  const match = soql.match(/\sFROM\s+(\w+)(?:\s|$)/i);
  return match ? match[1] : null;
}
