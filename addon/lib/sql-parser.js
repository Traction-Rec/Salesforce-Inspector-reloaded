// SQL Parser for extracting CTEs with SOQL comments
//
// This is a compatibility wrapper that re-exports from the modular sql-parser package.
// The actual implementation has been split into focused modules:
//
// - sql-parser/tokenizer.js: Low-level string parsing utilities
// - sql-parser/cte-parser.js: CTE extraction and parsing logic
// - sql-parser/soql-validator.js: SOQL validation functions
// - sql-parser/index.js: Main entry point with parseQuery()
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

export {
  extractCTEs,
  getFinalQuery,
  reconstructQuery,
  validateSOQL,
  extractObjectName,
  parseQuery
} from './sql-parser/index.js';
