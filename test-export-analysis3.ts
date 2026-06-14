import { Project } from 'ts-morph';
import ts from 'typescript';

const project = new Project({
  tsConfigFilePath: './tsconfig.server.json',
});

const sf = project.createSourceFile('exports-test3.ts', `
const InputFactory = () => {};
export default InputFactory;
`, { overwrite: true });

function syntaxKindName(kind: ts.SyntaxKind): string {
  return ts.SyntaxKind[kind];
}

console.log('=== TESTING export default InputFactory ===\n');

sf.forEachChild(node => {
  const kind = node.getKind();
  const kindName = syntaxKindName(kind);
  
  console.log(`Node kind: ${kindName}`);
  
  if (node.getText().includes('export default')) {
    console.log('Contains "export default"');
    
    // Check actual compiler kind
    const compilerNode = (node as any).compilerNode;
    console.log(`Compiler node kind: ${ts.SyntaxKind[compilerNode.kind]}`);
    
    // Check if it's ExportAssignment per ts.SyntaxKind
    console.log(`ts.SyntaxKind.ExportAssignment = ${ts.SyntaxKind.ExportAssignment}`);
    console.log(`Compiler node kind === ExportAssignment: ${compilerNode.kind === ts.SyntaxKind.ExportAssignment}`);
    
    // If it's ExportAssignment, check the expression
    if (compilerNode.kind === ts.SyntaxKind.ExportAssignment) {
      console.log('Confirmed: This is an ExportAssignment');
      const expr = (compilerNode as any).expression;
      if (expr) {
        console.log(`Expression kind: ${ts.SyntaxKind[expr.kind]}`);
        console.log(`Expression text (from source): ${expr.getText?.()}`);
      }
    }
  }
});

sf.delete();
