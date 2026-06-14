import { Project } from 'ts-morph';
import ts from 'typescript';

const project = new Project({
  tsConfigFilePath: './tsconfig.server.json',
});

const sf = project.getSourceFileOrThrow('./vite.config.ts');

function syntaxKindName(kind: ts.SyntaxKind): string {
  return ts.SyntaxKind[kind];
}

console.log('=== VITE.CONFIG.TS EXPORT ANALYSIS ===\n');

sf.forEachChild(node => {
  const kind = node.getKind();
  const kindName = syntaxKindName(kind);
  const text = node.getText();
  
  if (kindName === 'ImportDeclaration' || kindName === 'ExportAssignment' || text.includes('export default')) {
    console.log(`Kind: ${kindName}`);
    console.log(`Text: "${text.substring(0, 70)}${text.length > 70 ? '...' : ''}"`);
    
    if (kindName === 'ExportAssignment') {
      const expr = (node as any).getExpression?.();
      if (expr) {
        const exprKind = syntaxKindName(expr.getKind());
        console.log(`Expression kind: ${exprKind}`);
        console.log(`Expression text: "${expr.getText().substring(0, 50)}"`);
      }
    }
    console.log();
  }
});
