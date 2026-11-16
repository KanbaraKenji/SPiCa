// The same reading as scan.ts, done by the TypeScript parser (strings, templates, JSX text and attributes), for
// main/i18n.test.ts: a regex literal or a quote in JSX text cannot throw it off. Not imported by the app.
import ts from 'typescript';
import { CJK, SKIP_MARK, type Found } from './scan';

const KEY_CALLS = new Set(['t', 'tn', 'N_', 'tc']);

/** Every text with Chinese in a source file, with its line and the key it is (when it is one). */
export function scanSourceAst(src: string, fileName = 'x.tsx'): Found[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = src.split('\n');
  const skipped = new Set<number>();
  lines.forEach((l, n) => {
    if (!l.includes(SKIP_MARK)) return;
    skipped.add(n + 1);
    if (/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(l)) skipped.add(n + 2);
  });
  const out: Found[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const keyOf = (node: ts.Node): { key: string; ctx?: string } | undefined => {
    const call = node.parent;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !KEY_CALLS.has(call.expression.text)) return undefined;
    if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return undefined;
    const name = call.expression.text;
    const i = call.arguments.indexOf(node as ts.Expression);
    if (name === 'tc') {
      const ctx = call.arguments[0];
      return i === 1 && ctx && ts.isStringLiteral(ctx) ? { key: `${node.text}|${ctx.text}`, ctx: ctx.text } : undefined;
    }
    return i === 0 ? { key: node.text } : undefined;
  };
  const visit = (node: ts.Node) => {
    let text: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join('${}');
    else if (ts.isJsxText(node)) text = node.text.trim();
    if (text !== undefined && CJK.test(text)) {
      const line = lineOf(node);
      if (!skipped.has(line)) {
        const k = keyOf(node);
        out.push({ line, text, ...(k ? k : {}) });
      }
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
