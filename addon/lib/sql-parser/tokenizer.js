// SQL tokenizer utilities for parsing SQL strings while respecting quotes and comments
//
// This module provides low-level tokenization utilities used by the SQL parser
// to correctly handle string literals, comments, and other SQL syntax elements.

/**
 * Strips leading SQL comments (-- line comments and /​* block comments)
 * and whitespace from a query string.
 * 
 * @param {string} query - The SQL query string
 * @returns {string} The query with leading comments and whitespace removed
 */
export function stripLeadingComments(query) {
  let result = query;
  let changed = true;
  while (changed) {
    changed = false;
    // Strip leading whitespace
    const trimmed = result.replace(/^\s+/, '');
    if (trimmed !== result) {
      result = trimmed;
      changed = true;
    }
    // Strip leading line comments (-- ...)
    if (result.startsWith('--')) {
      const lineEnd = result.indexOf('\n');
      if (lineEnd === -1) {
        result = '';
      } else {
        result = result.substring(lineEnd + 1);
      }
      changed = true;
    }
    // Strip leading block comments (/* ... */)
    if (result.startsWith('/*')) {
      const commentEnd = result.indexOf('*/');
      if (commentEnd === -1) {
        result = '';
      } else {
        result = result.substring(commentEnd + 2);
      }
      changed = true;
    }
  }
  return result;
}

/**
 * Context state for tracking position in SQL string parsing
 */
class ParserContext {
  constructor(input) {
    this.input = input;
    this.index = 0;
    this.inString = false;
    this.stringChar = '';
    this.depth = 0;
  }

  get currentChar() {
    return this.input[this.index] || '';
  }

  get nextChar() {
    return this.input[this.index + 1] || '';
  }

  get remaining() {
    return this.input.substring(this.index);
  }

  advance(count = 1) {
    this.index += count;
  }

  isAtEnd() {
    return this.index >= this.input.length;
  }
}

/**
 * Handles string literal parsing, tracking when we're inside quotes.
 * Advances ctx past whatever was consumed so callers must NOT advance again.
 * 
 * @param {ParserContext} ctx - Parser context
 * @returns {boolean} True if a character (or characters) were consumed
 */
export function handleStringLiteral(ctx) {
  const ch = ctx.currentChar;

  if (ctx.inString) {
    if (ch === ctx.stringChar) {
      if (ctx.nextChar === ctx.stringChar) {
        // Escaped quote – consume both characters
        ctx.advance(2);
        return true;
      }
      // Closing quote
      ctx.inString = false;
    }
    ctx.advance();
    return true;
  }

  // Not currently inside a string
  if (ch === "'" || ch === '"') {
    ctx.inString = true;
    ctx.stringChar = ch;
    ctx.advance();
    return true;
  }

  return false;
}

/**
 * Skips over a block comment (/​* ... *​/)
 * 
 * @param {ParserContext} ctx - Parser context
 * @returns {boolean} True if a comment was skipped
 */
export function skipBlockComment(ctx) {
  if (ctx.currentChar === '/' && ctx.nextChar === '*') {
    let commentEnd = ctx.input.indexOf('*/', ctx.index + 2);
    if (commentEnd === -1) {
      commentEnd = ctx.input.length - 2;
    }
    ctx.index = commentEnd + 2;
    return true;
  }
  return false;
}

/**
 * Skips over a line comment (-- ...)
 * 
 * @param {ParserContext} ctx - Parser context
 * @returns {boolean} True if a comment was skipped
 */
export function skipLineComment(ctx) {
  if (ctx.currentChar === '-' && ctx.nextChar === '-') {
    let lineEnd = ctx.input.indexOf('\n', ctx.index);
    if (lineEnd === -1) {
      lineEnd = ctx.input.length;
    }
    ctx.index = lineEnd;
    return true;
  }
  return false;
}

/**
 * Tracks parentheses depth
 * 
 * @param {ParserContext} ctx - Parser context
 * @returns {boolean} True if a parenthesis was processed
 */
export function handleParentheses(ctx) {
  if (ctx.currentChar === '(') {
    ctx.depth++;
    return true;
  }
  if (ctx.currentChar === ')') {
    ctx.depth--;
    return true;
  }
  return false;
}

export { ParserContext };
