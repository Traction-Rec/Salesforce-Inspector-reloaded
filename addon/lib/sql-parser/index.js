// SQL Parser for extracting CTEs with SOQL comments
//
// This module parses SQLite queries with CTEs that contain SOQL extraction directives
// in magic comments. It extracts the SOQL queries to execute against Salesforce and
// the final SQL query to run against the local SQLite database.
//
// Example input:
//   WITH accounts AS (
//     /* SOQL: SELECT Id, Name, Industry FROM Account WHERE Industry != null */
//     SELECT * FROM accounts
//   ),
//   contacts AS (
//     /* SOQL: SELECT Id, FirstName, LastName, AccountId FROM Contact */
//     SELECT * FROM contacts
//   )
//   SELECT a.Name, a.Industry, c.FirstName, c.LastName
//   FROM accounts a
//   JOIN contacts c ON a.Id = c.AccountId
//   WHERE a.Industry = 'Technology'

import { stripLeadingComments } from './tokenizer.js';
import { extractCTEs, getFinalQuery, reconstructQuery } from './cte-parser.js';
import { validateSOQL, extractObjectName } from './soql-validator.js';

// Re-export for backward compatibility
export { extractCTEs, getFinalQuery, reconstructQuery, validateSOQL, extractObjectName };

/**
 * Parses a query that might be a simple SOQL query (no CTEs) or a SQL query with CTEs.
 * Returns appropriate instructions for execution.
 * 
 * @param {string} query - The input query
 * @returns {{type: 'soql'|'sql', soql?: string, ctes?: Array, finalQuery?: string, error?: string}}
 */
export function parseQuery(query) {
  const trimmed = query.trim();
  
  // Strip leading SQL comments (-- and /* */) before determining query type
  const stripped = stripLeadingComments(trimmed);
  
  // Check if it's a plain SOQL query (starts with SELECT but not WITH)
  if (/^SELECT\s/i.test(stripped) && !/^WITH\s/i.test(stripped)) {
    const validation = validateSOQL(stripped);
    if (!validation.valid) {
      return { type: 'soql', error: validation.error };
    }
    return { type: 'soql', soql: stripped };
  }
  
  // Check if it starts with WITH (CTE query)
  if (/^WITH\s/i.test(stripped)) {
    // Pass the original trimmed query so extractCTEs/getFinalQuery can strip comments themselves
    const ctes = extractCTEs(trimmed);
    const finalQuery = getFinalQuery(trimmed);
    
    // Validate that we have at least one CTE with SOQL
    const ctesWithSoql = ctes.filter(cte => cte.soql);
    if (ctesWithSoql.length === 0) {
      return { 
        type: 'sql', 
        error: 'No SOQL extraction directives found. Add /* SOQL: SELECT ... */ comments to CTEs.' 
      };
    }
    
    // Validate all SOQL queries
    for (const cte of ctesWithSoql) {
      const validation = validateSOQL(cte.soql);
      if (!validation.valid) {
        return { 
          type: 'sql', 
          error: `Invalid SOQL in CTE "${cte.name}": ${validation.error}` 
        };
      }
    }
    
    return { type: 'sql', ctes, finalQuery };
  }
  
  return { type: 'soql', error: 'Query must start with SELECT or WITH' };
}
