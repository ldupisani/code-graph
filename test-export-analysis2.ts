import { Project } from 'ts-morph';
import ts from 'typescript';

const project = new Project({
  tsConfigFilePath: './tsconfig.server.json',
});

const sf = project.createSourceFile('exports-test2.ts', `
const InputFactory = () => {};
export default InputFactory;
export { InputFactory }
`, { overwrite: true });

function syntaxKindName(kind: ts.SyntaxKind): string {
  return ts.SyntaxKind[kind];
}

console.log('=== DETAILED EXPORT ASSIGNMENT ANALYSIS ===\n');

let statementNum = 0;
sf.forEachChild(node => {
  const kind = node.getKind();
  const kindName = syntaxKindName(kind);
  const text = node.getText();
  
  if (text.trim().startsWith('//') || kindName === 'EndOfFileToken') return;
  
  statementNum++;
  console.log(`\n--- Statement ${statementNum}: ${kindName} ---`);
  console.log(`Text: "${text}"`);
  
  if (kindName === 'ExportAssignment') {
    console.log('This is an ExportAssignment node');
    const expr = (node as any).getExpression?.();
    console.log(`Has getExpression: ${!!expr}`);
    
    if (expr) {
      console.log(`Expression kind: ${syntaxKindName(expr.getKind())}`);
      console.log(`Expression text: "${expr.getText()}"`);
      console.log(`Expression is Identifier: ${expr.getKind() === ts.SyntaxKind.Identifier}`);
      
      if (expr.getKind() === ts.SyntaxKind.Identifier) {
        try {
          const symbol = expr.getSymbol();
          console.log(`Identifier symbol exists: ${!!symbol}`);
          if (symbol) {
            console.log(`Symbol name: ${symbol.getName()}`);
            const decls = symbol.getDeclarations();
            console.log(`Symbol declarations: ${decls.length}`);
            for (const decl of decls) {
              const declKind = syntaxKindName(decl.getKind());
              const declText = decl.getText().substring(0, 50);
              console.log(`  - ${declKind}: "${declText}..."`);
            }
          }
        } catch (e) {
          console.log(`Error getting symbol: ${e.message}`);
        }
      }
    }
  }
  
  if (kindName === 'VariableStatement' || kindName === 'EmptyStatement') {
    console.log('Variable/Export const declaration');
    try {
      const isExp = (node as any).isExported?.();
      console.log(`isExported(): ${isExp}`);
    } catch {}
  }
});

sf.delete();
