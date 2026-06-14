import { Project } from 'ts-morph';
import ts from 'typescript';

const project = new Project({
  tsConfigFilePath: './tsconfig.server.json',
});

const sf = project.createSourceFile('test-name.ts', `
const InputFactory = () => {};
export default InputFactory;
export { InputFactory }
export { InputFactory as Factory }
`, { overwrite: true });

function syntaxKindName(kind: ts.SyntaxKind): string {
  return ts.SyntaxKind[kind];
}

console.log('=== ExportAssignment / ExportDeclaration Name Testing ===\n');

let count = 0;
sf.forEachChild(node => {
  const kind = node.getKind();
  const kindName = syntaxKindName(kind);
  const text = node.getText();
  
  if (text.trim().startsWith('//') || kindName === 'EndOfFileToken') return;
  if (!text.includes('export')) return;
  
  count++;
  console.log(`\n--- Export ${count}: ${kindName} ---`);
  console.log(`Text: "${text}"`);
  
  // Try getName
  try {
    const name = (node as any).getName?.();
    console.log(`getName(): "${name}"`);
  } catch (e) {
    console.log(`getName() error: ${(e as any).message}`);
  }
  
  // Try getNameNode
  try {
    const nameNode = (node as any).getNameNode?.();
    console.log(`getNameNode(): ${nameNode ? syntaxKindName(nameNode.getKind()) : 'null'}`);
  } catch (e) {
    console.log(`getNameNode() error: ${(e as any).message}`);
  }
  
  // For ExportAssignment check if it has getExpression
  try {
    const expr = (node as any).getExpression?.();
    if (expr) {
      const exprKind = syntaxKindName(expr.getKind());
      console.log(`getExpression(): ${exprKind}`);
      
      // If it's Identifier, try to get its name
      if (expr.getKind() === ts.SyntaxKind.Identifier) {
        console.log(`  Expression text: "${expr.getText()}"`);
      }
    }
  } catch (e) {
    console.log(`getExpression() error: ${(e as any).message}`);
  }
});

sf.delete();
