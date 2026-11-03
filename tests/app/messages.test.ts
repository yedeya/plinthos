import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en } from '../../src/app/messages/en';
import { repoRoot } from '../support/repo-file';

/**
 * `[ITEM-9]` and `docs/design/ui.md`: every text the admin shows lives in one message file,
 * `src/app/messages/en.ts` (`HANDOVER.md` §10.9). A simple check of every component under
 * `src/app/`: no JSX text and no string attribute a person reads (`aria-label`, `placeholder`,
 * `title`, `alt`) holds a letter. Symbols such as `−`, `+` and `✓` are allowed.
 */

const READ_ATTRIBUTES = new Set(['aria-label', 'placeholder', 'title', 'alt', 'aria-description', 'aria-placeholder']);

function componentFiles(): string[] {
  const app = join(repoRoot, 'src', 'app');
  return readdirSync(app, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Every visible text written into a component's source, as `file:line text`. */
function writtenTexts(file: string, source = readFileSync(file, 'utf8')): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const at = (node: ts.Node, text: string) => found.push(`${relative(repoRoot, file)}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1} ${text.trim()}`);
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && /\p{L}/u.test(node.text)) at(node, node.text);
    if (ts.isJsxExpression(node) && node.expression !== undefined && ts.isStringLiteralLike(node.expression) && ts.isJsxElement(node.parent) && /\p{L}/u.test(node.expression.text)) {
      at(node, node.expression.text);
    }
    if (ts.isJsxAttribute(node) && READ_ATTRIBUTES.has(node.name.getText(tree)) && node.initializer !== undefined) {
      const value = ts.isStringLiteral(node.initializer) ? node.initializer : ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined && ts.isStringLiteralLike(node.initializer.expression) ? node.initializer.expression : undefined;
      if (value !== undefined && /\p{L}/u.test(value.text)) at(node, `${node.name.getText(tree)}="${value.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

describe('the admin’s texts', () => {
  it('[ITEM-9] live in the message file: no component under src/app/ writes visible text of its own', () => {
    const files = componentFiles();
    expect(files.map((file) => relative(repoRoot, file))).toEqual(expect.arrayContaining(['src/app/_admin/entry-form.tsx', 'src/app/admin/page.tsx', 'src/app/login/page.tsx', 'src/app/offline/page.tsx']));
    expect(files.flatMap((file) => writtenTexts(file))).toEqual([]);
  });

  it('[ITEM-9] the check finds text written into a component, so it can fail', () => {
    const probe = join(repoRoot, 'src', 'app', 'made-up-probe.tsx');
    const found = writtenTexts(probe, `export const P = () => <p title="Made-up title" aria-label={'Made-up label'}>Made-up text {'more text'} {en.app.name} −</p>;`);
    expect(found.map((line) => line.replace(/^.*:\d+ /, ''))).toEqual(['title="Made-up title"', 'aria-label="Made-up label"', 'Made-up text', 'more text']);
  });

  it('[ITEM-9] names every condition and every queue state', () => {
    expect(Object.keys(en.condition).sort()).toEqual(['SEALED', 'USED_NO_BOX', 'USED_WITH_BOX']);
    expect(Object.keys(en.queue.state).sort()).toEqual(['abandoned', 'error', 'held', 'loading', 'offline', 'retrying', 'signed-out', 'synced']);
  });
});
