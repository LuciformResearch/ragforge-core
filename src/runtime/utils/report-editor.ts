/**
 * ReportEditor - File-based markdown report editor
 *
 * Stores the report in a file for observability and uses the same
 * edit logic as edit_file (fuzzy matching, uniqueness check, etc.)
 *
 * Reports are stored in ~/.ragforge/reports/
 *
 * @since 2025-12-15
 * @updated 2025-12-16 - Switched to file-based approach
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getFilenameTimestamp } from './timestamp.js';

// Import the fuzzy replace logic from file-tools
import { replaceWithFuzzyMatch, stripLineNumberPrefixes } from '../../tools/file-tools.js';

export interface EditResult {
  success: boolean;
  error?: string;
  /** Content after edit */
  content: string;
  /** Path to the report file */
  filePath?: string;
}

/**
 * File-based ReportEditor
 *
 * - Creates a single report file at construction time
 * - All edits go directly to the file
 * - Uses the same edit logic as edit_file (fuzzy match, uniqueness)
 * - Observable: you can tail -f the report while research runs
 */
export class ReportEditor {
  private reportPath: string;
  private reportDir: string;

  constructor(sessionId?: string) {
    // Create reports directory
    this.reportDir = path.join(os.homedir(), '.ragforge', 'reports');
    if (!fs.existsSync(this.reportDir)) {
      fs.mkdirSync(this.reportDir, { recursive: true });
    }

    // Create report file path with timestamp (fixed for entire session)
    const timestamp = sessionId || getFilenameTimestamp();
    this.reportPath = path.join(this.reportDir, `report-${timestamp}.md`);

    // Initialize empty file
    fs.writeFileSync(this.reportPath, '', 'utf-8');
  }

  // ============================================
  // Read Operations
  // ============================================

  /**
   * Get the report file path
   */
  getFilePath(): string {
    return this.reportPath;
  }

  /**
   * Get current report content
   */
  getContent(): string {
    try {
      return fs.readFileSync(this.reportPath, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Get report length in characters
   */
  getLength(): number {
    return this.getContent().length;
  }

  /**
   * Check if report is empty
   */
  isEmpty(): boolean {
    return this.getContent().trim() === '';
  }

  // ============================================
  // Write Operations
  // ============================================

  /**
   * Set full report content (use for initial draft)
   */
  setReport(content: string): EditResult {
    try {
      fs.writeFileSync(this.reportPath, content, 'utf-8');
      return { success: true, content, filePath: this.reportPath };
    } catch (err: any) {
      return { success: false, error: err.message, content: this.getContent() };
    }
  }

  /**
   * Search and replace text in report
   * Uses the same fuzzy matching logic as edit_file
   *
   * @param oldText Text to find
   * @param newText Replacement text
   * @param replaceAll Replace all occurrences (default: false)
   */
  replace(oldText: string, newText: string, replaceAll: boolean = false): EditResult {
    if (!oldText) {
      return { success: false, error: 'old_text cannot be empty', content: this.getContent() };
    }

    const currentContent = this.getContent();

    // Strip line number prefixes (like edit_file does)
    const cleanOld = stripLineNumberPrefixes(oldText);
    const cleanNew = stripLineNumberPrefixes(newText);

    if (cleanOld === cleanNew) {
      return { success: false, error: 'old_text and new_text must be different', content: currentContent };
    }

    try {
      // Use the same fuzzy matching as edit_file
      const newContent = replaceWithFuzzyMatch(currentContent, cleanOld, cleanNew, replaceAll);
      fs.writeFileSync(this.reportPath, newContent, 'utf-8');
      return { success: true, content: newContent, filePath: this.reportPath };
    } catch (err: any) {
      return { success: false, error: err.message, content: currentContent };
    }
  }

  /**
   * Append content to end of report
   */
  append(text: string): EditResult {
    if (!text) {
      return { success: false, error: 'content cannot be empty', content: this.getContent() };
    }

    const currentContent = this.getContent();

    // Ensure proper spacing
    const trimmedContent = currentContent.trimEnd();
    const needsNewlines = trimmedContent.length > 0 && !trimmedContent.endsWith('\n\n');
    const newContent = trimmedContent + (needsNewlines ? '\n\n' : '') + text;

    try {
      fs.writeFileSync(this.reportPath, newContent, 'utf-8');
      return { success: true, content: newContent, filePath: this.reportPath };
    } catch (err: any) {
      return { success: false, error: err.message, content: currentContent };
    }
  }

  /**
   * Insert content after a heading
   * @param heading The heading to insert after (e.g., "## Summary")
   * @param content Content to insert
   */
  insertAfterHeading(heading: string, content: string): EditResult {
    if (!heading || !content) {
      return { success: false, error: 'heading and content are required', content: this.getContent() };
    }

    const currentContent = this.getContent();
    const section = this.findSection(currentContent, heading);

    if (!section) {
      return { success: false, error: `Heading not found: "${heading}"`, content: currentContent };
    }

    // Find the end of the heading line
    const headingEndPos = currentContent.indexOf('\n', section.startPos);
    let newContent: string;

    if (headingEndPos === -1) {
      // Heading is at end of file
      newContent = currentContent + '\n\n' + content;
    } else {
      // Insert after heading line
      newContent = currentContent.slice(0, headingEndPos) + '\n\n' + content + currentContent.slice(headingEndPos);
    }

    try {
      fs.writeFileSync(this.reportPath, newContent, 'utf-8');
      return { success: true, content: newContent, filePath: this.reportPath };
    } catch (err: any) {
      return { success: false, error: err.message, content: currentContent };
    }
  }

  /**
   * Replace entire section (heading + content until next same-level heading)
   * @param heading The section heading to replace
   * @param newSectionContent New content for the section (heading will be preserved)
   */
  replaceSection(heading: string, newSectionContent: string): EditResult {
    if (!heading) {
      return { success: false, error: 'heading is required', content: this.getContent() };
    }

    const currentContent = this.getContent();
    const section = this.findSection(currentContent, heading);

    if (!section) {
      return { success: false, error: `Section not found: "${heading}"`, content: currentContent };
    }

    // Preserve original heading
    let replacement = section.heading + '\n\n' + newSectionContent;
    if (!replacement.endsWith('\n')) {
      replacement += '\n';
    }

    const newContent = currentContent.slice(0, section.startPos) + replacement + currentContent.slice(section.endPos);

    try {
      fs.writeFileSync(this.reportPath, newContent, 'utf-8');
      return { success: true, content: newContent, filePath: this.reportPath };
    } catch (err: any) {
      return { success: false, error: err.message, content: currentContent };
    }
  }

  /**
   * Delete a section
   */
  deleteSection(heading: string): EditResult {
    const currentContent = this.getContent();
    const section = this.findSection(currentContent, heading);

    if (!section) {
      return { success: false, error: `Section not found: "${heading}"`, content: currentContent };
    }

    let newContent = currentContent.slice(0, section.startPos) + currentContent.slice(section.endPos);
    // Clean up extra newlines
    newContent = newContent.replace(/\n{3,}/g, '\n\n').trim();

    try {
      fs.writeFileSync(this.reportPath, newContent, 'utf-8');
      return { success: true, content: newContent, filePath: this.reportPath };
    } catch (err: any) {
      return { success: false, error: err.message, content: currentContent };
    }
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Find a section by heading (partial match, case-insensitive)
   */
  private findSection(content: string, searchHeading: string): { heading: string; startPos: number; endPos: number; level: number } | undefined {
    const lines = content.split('\n');
    const headingRegex = /^(#{1,6})\s+(.+)$/;
    const normalizedSearch = searchHeading.trim().replace(/\s+/g, ' ').toLowerCase();

    const headings: Array<{ heading: string; level: number; startPos: number }> = [];
    let currentPos = 0;

    // Find all headings
    for (const line of lines) {
      const match = line.match(headingRegex);
      if (match) {
        headings.push({
          heading: line,
          level: match[1].length,
          startPos: currentPos,
        });
      }
      currentPos += line.length + 1;
    }

    // Find matching heading
    const matchIndex = headings.findIndex(h => {
      const normalizedHeading = h.heading.trim().replace(/\s+/g, ' ').toLowerCase();
      return normalizedHeading.includes(normalizedSearch) || normalizedSearch.includes(normalizedHeading);
    });

    if (matchIndex === -1) return undefined;

    const h = headings[matchIndex];
    let endPos = content.length;

    // Find next heading of same or higher level
    for (let j = matchIndex + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        endPos = headings[j].startPos;
        break;
      }
    }

    return { heading: h.heading, startPos: h.startPos, endPos, level: h.level };
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Get a preview of the report (first N characters)
   */
  getPreview(maxLength: number = 500): string {
    const content = this.getContent();
    if (content.length <= maxLength) {
      return content;
    }
    return content.slice(0, maxLength) + '...';
  }

  /**
   * Get word count
   */
  getWordCount(): number {
    return this.getContent()
      .split(/\s+/)
      .filter(word => word.length > 0)
      .length;
  }
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a new file-based ReportEditor
 * @param sessionId Optional session ID for the report filename (default: current timestamp)
 */
export function createReportEditor(sessionId?: string): ReportEditor {
  return new ReportEditor(sessionId);
}
