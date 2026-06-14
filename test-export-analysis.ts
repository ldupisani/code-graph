import { Project } from 'ts-morph';
import ts from 'typescript';

const project = new Project({
  tsConfigFilePath: './tsconfig.server.json',
});

const sf = project.createSourceFile('exports-test.ts', `
// Case 1: default export of a reference
const InputFactory = () => {};
InputFactory.displayName = 'InputFactory';
export default InputFactory;

// Case 2: default export of inline function
export default function Foo() {}

// Case 3: export const
export const MyVar = 123;

// Case 4: named export
export { InputFactory }
`, { overwrite: true });

function syntaxKindName(kind: ts.SyntaxKind): string {
  const name = ts.SyntaxKind[kind];
  return name;
}

console.log('=== EXPORT STRUCTURE ANALYSIS ===\n');

let caseNum = 0;
sf.forEachChild(node => {
  const kind = node.getKind();
  const kindName = syntaxKindName(kind);
  const text = node.getText();
  
  // Skip comment-only lines
  if (text.trim().startsWith('//')) return;
  
  caseNum++;
  
  console.log(`\n--- Case ${caseNum}: ${kindName} ---`);
  console.log(`Text: ${text.substring(0, 60)}${text.length > 60 ? '...' : ''}`);
  
  // Try to get a name
  try {
    const name = (node as any).getName?.();
    if (name) console.log(`getName(): "${name}"`);
  } catch (e) {}
  
  // Check if it's exported (for Exportable nodes)
  if ((node as any).isExported) {
    try {
      const isExported = (node as any).isExported();
      console.log(`isExported(): ${isExported}`);
    } catch (e) {}
  }
  
  // For ExportAssignment, check its expression
  if (kindName === 'ExportAssignment') {
    const expr = (node as any).getExpression?.();
    if (expr) {
      const exprKind = syntaxKindName(expr.getKind());
      console.log(`Expression kind: ${exprKind}`);
      const exprText = expr.getText();
      console.log(`Expression text: "${exprText.substring(0, 50)}${exprText.length > 50 ? '...' : ''}"`);
      console.log(`Expression is Identifier: ${exprKind === 'Identifier'}`);
    }
  }
  
  // List immediate children
  const children = node.getChildren();
  console.log(`Children (${children.length}):`);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const childKind = syntaxKindName(child.getKind());
    const childText = child.getText().substring(0, 30).replace(/\n/g, '\\n');
    console.log(`  [${i}] ${childKind}: "${childText}${child.getText().length > 30 ? '...' : ''}"`);
  }
});

sf.delete();
